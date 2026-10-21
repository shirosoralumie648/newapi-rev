package service

import (
	"errors"
	"time"

	"github.com/QuantumNous/new-api/model"
)

// ---------------------------------------------------------------------------
// FundingSource — 资金来源接口（钱包 or 订阅）
// ---------------------------------------------------------------------------

// FundingSource 抽象了预扣费的资金来源。
type FundingSource interface {
	// Source 返回资金来源标识："wallet" 或 "subscription"
	Source() string
	// PreConsume 从该资金来源预扣 amount 额度
	PreConsume(amount int) error
	// Settle 根据差额调整资金来源（正数补扣，负数退还）
	Settle(delta int) error
	// Refund 退还所有预扣费
	Refund() error
}

// ---------------------------------------------------------------------------
// WalletFunding — 钱包资金来源实现
// ---------------------------------------------------------------------------

// ErrInsufficientWalletQuota 钱包原子预扣失败（余额不足），未发生任何扣减。
// BillingSession 据此映射为 ErrorCodeInsufficientUserQuota，
// 使 wallet_first 等计费偏好可以回退到订阅。
var ErrInsufficientWalletQuota = errors.New("wallet quota insufficient")

type WalletFunding struct {
	userId   int
	consumed int // 实际预扣的用户额度
	// requestId 是钱包退款的幂等引用（relay 请求 ID）。
	requestId string
}

func (w *WalletFunding) Source() string { return BillingSourceWallet }

func (w *WalletFunding) PreConsume(amount int) error {
	if amount <= 0 {
		return nil
	}
	reserved, err := model.TryReserveUserQuota(w.userId, amount, w.requestId)
	if err != nil {
		return err
	}
	if !reserved {
		return ErrInsufficientWalletQuota
	}
	// 发送前补扣会再次预扣，累加后退款才能退回全部预扣。
	w.consumed += amount
	model.RecordWalletConsumeDelta(w.userId, -int64(amount))
	return nil
}

func (w *WalletFunding) Settle(delta int) error {
	if w.requestId == "" {
		if delta == 0 {
			return nil
		}
		if delta > 0 {
			// 无 requestId 的兼容路径同样受透支上限约束：超出信用额度的部分
			// 记为欠款，只有真正扣走的额度计入消费账本。
			applied, err := model.SettleWalletCharge(w.userId, delta)
			if err != nil {
				return err
			}
			model.RecordWalletConsumeDelta(w.userId, -int64(applied))
			return nil
		}
		if err := model.IncreaseUserQuota(w.userId, -delta, false); err != nil {
			return err
		}
		model.RecordWalletConsumeDelta(w.userId, -int64(delta))
		return nil
	}
	// 结算与关闭 hold 在同一事务内完成：崩溃后回收任务据此判断预扣是否已结束，
	// 重放同一 requestId 不会二次扣费。
	charged, err := model.SettleWalletHold(w.userId, w.requestId, int64(delta))
	if err != nil {
		return err
	}
	if charged != 0 {
		model.RecordWalletConsumeDelta(w.userId, -charged)
	}
	return nil
}

func (w *WalletFunding) Refund() error {
	if w.requestId == "" {
		if w.consumed <= 0 {
			return nil
		}
		if err := model.IncreaseUserQuota(w.userId, w.consumed, false); err != nil {
			return err
		}
		model.RecordWalletConsumeDelta(w.userId, int64(w.consumed))
		return nil
	}
	// 账本引用与 hold 状态共同保证退款幂等：重复调用同一 requestId 不会二次退款，
	// 退款金额取持久化的 hold 金额而不是内存计数。
	_, err := model.RefundWalletHold(w.userId, w.requestId, w.consumed)
	return err
}

// ---------------------------------------------------------------------------
// WorkflowBudgetFunding — 工作流运行预算资金来源实现（BL-03）
// ---------------------------------------------------------------------------

// WorkflowBudgetFunding bills one workflow step inside the run budget its
// canvas opened. The step reserves a child allocation of the budget the wallet
// already paid for and later records its actual cost there, so no per-step
// wallet movement happens. The run settlement charges the sum of the step
// allocations and returns the unused part of the cap.
type WorkflowBudgetFunding struct {
	userId int
	// runId is the root budget hold; requestId names this step's child
	// allocation (the relay request id, which is also what a durable task
	// row keeps so its poller can settle the same child).
	runId     string
	requestId string
	// reserved is the step's current allocation, in quota.
	reserved int
}

func (f *WorkflowBudgetFunding) Source() string { return BillingSourceWorkflowBudget }

func (f *WorkflowBudgetFunding) PreConsume(amount int) error {
	// The run cap was already reserved from the wallet when the run started, so
	// the only limit a step has to satisfy is the remaining budget.
	return f.reserve(amount)
}

// reserve replaces the step's allocation with the absolute amount.
func (f *WorkflowBudgetFunding) reserve(amount int) error {
	if amount < 0 {
		amount = 0
	}
	if amount == f.reserved {
		return nil
	}
	if f.reserved == 0 && amount == 0 {
		return nil
	}
	_, err := model.ReserveWalletBudgetChild(f.runId, f.requestId, f.userId, amount)
	if err != nil {
		return err
	}
	f.reserved = amount
	return nil
}

// ReserveExtra extends the step's allocation by delta, mirroring the wallet
// reserve path for mid-flight quantity increases.
func (f *WorkflowBudgetFunding) ReserveExtra(delta int) error {
	return f.reserve(f.reserved + delta)
}

// ReleaseExtra shrinks the step's allocation after a failed reserve rollback.
func (f *WorkflowBudgetFunding) ReleaseExtra(delta int) error {
	return f.reserve(f.reserved - delta)
}

// Settle records the step's actual cost (pre-consume plus delta) in the budget.
func (f *WorkflowBudgetFunding) Settle(delta int) error {
	actual := f.reserved + delta
	if actual < 0 {
		actual = 0
	}
	_, err := model.SettleWalletBudgetChild(f.runId, f.requestId, f.userId, actual)
	return err
}

// Refund releases the step's allocation: the budget keeps the money, so a
// failed step leaves the run's spend untouched.
func (f *WorkflowBudgetFunding) Refund() error {
	if f.reserved == 0 {
		return nil
	}
	_, err := model.SettleWalletBudgetChild(f.runId, f.requestId, f.userId, 0)
	return err
}

// ---------------------------------------------------------------------------
// SubscriptionFunding — 订阅资金来源实现
// ---------------------------------------------------------------------------

type SubscriptionFunding struct {
	requestId      string
	userId         int
	group          string
	modelName      string
	amount         int64 // 预扣的订阅额度（subConsume）
	subscriptionId int
	preConsumed    int64
	// lastSettlement 记录最近一次结算如何分配 delta（订阅承担 / 钱包承担超额）。
	// BillingSession 据此写入 relayInfo 的日志字段。
	lastSettlement *model.SubscriptionSettlementResult
	// 以下字段在 PreConsume 成功后填充，供 RelayInfo 同步使用
	AmountTotal     int64
	AmountUsedAfter int64
	PlanId          int
	PlanTitle       string
}

func (s *SubscriptionFunding) Source() string { return BillingSourceSubscription }

func (s *SubscriptionFunding) PreConsume(_ int) error {
	// amount 参数被忽略，使用内部 s.amount（已在构造时根据 preConsumedQuota 计算）
	res, err := model.PreConsumeUserSubscription(s.requestId, s.userId, s.group, s.modelName, 0, s.amount)
	if err != nil {
		return err
	}
	s.subscriptionId = res.UserSubscriptionId
	s.preConsumed = res.PreConsumed
	s.AmountTotal = res.AmountTotal
	s.AmountUsedAfter = res.AmountUsedAfter
	// 获取订阅计划信息
	if planInfo, err := model.GetSubscriptionPlanInfoByUserSubscriptionId(res.UserSubscriptionId); err == nil && planInfo != nil {
		s.PlanId = planInfo.PlanId
		s.PlanTitle = planInfo.PlanTitle
	}
	return nil
}

func (s *SubscriptionFunding) Settle(delta int) error {
	if delta == 0 {
		return nil
	}
	// 单一事务内结算：订阅额度用尽时按套餐 AllowWalletOverflow 把超额转扣钱包，
	// 并向钱包账本写入对应的消费行。
	result, err := model.SettleUserSubscriptionDelta(s.subscriptionId, int64(delta))
	if err != nil {
		return err
	}
	s.lastSettlement = result
	return nil
}

func (s *SubscriptionFunding) Refund() error {
	if s.preConsumed <= 0 {
		return nil
	}
	return refundWithRetry(func() error {
		return model.RefundSubscriptionPreConsume(s.requestId)
	})
}

// refundWithRetry 尝试多次执行退款操作以提高成功率，只能用于基于事务的退款函数！！！！！！
// try to refund with retries, only for refund functions based on transactions!!!
func refundWithRetry(fn func() error) error {
	if fn == nil {
		return nil
	}
	const maxAttempts = 3
	var lastErr error
	for i := range maxAttempts {
		if err := fn(); err == nil {
			return nil
		} else {
			lastErr = err
		}
		if i < maxAttempts-1 {
			time.Sleep(time.Duration(200*(i+1)) * time.Millisecond)
		}
	}
	return lastErr
}
