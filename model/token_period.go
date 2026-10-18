package model

import "time"

// 令牌周期预算的重置周期：日=本地零点，周=周一零点，月=每月一号零点。
const (
	TokenPeriodDaily   = "day"
	TokenPeriodWeekly  = "week"
	TokenPeriodMonthly = "month"
)

// HasPeriodQuota 报告令牌是否启用了周期预算：每个周期内至多消费
// PeriodQuota，超出的请求被拒绝且不影响钱包余额。
func (token *Token) HasPeriodQuota() bool {
	return token.PeriodQuota > 0 && token.PeriodResetPeriod != ""
}

// TokenPeriodWindowStart 返回包含 now 的重置窗口起点（Unix 秒）。窗口使用
// 服务器本地时区，边界与订阅重置一致：日=当天零点，周=周一零点，
// 月=当月一号零点。未知周期返回 0，调用方按“未启用周期预算”处理。
func TokenPeriodWindowStart(period string, now int64) int64 {
	current := time.Unix(now, 0)
	dayStart := time.Date(current.Year(), current.Month(), current.Day(), 0, 0, 0, 0, current.Location())
	switch period {
	case TokenPeriodDaily:
		return dayStart.Unix()
	case TokenPeriodWeekly:
		// Weekday() 周天=0，折算为周一=0。
		offset := (int(dayStart.Weekday()) + 6) % 7
		return dayStart.AddDate(0, 0, -offset).Unix()
	case TokenPeriodMonthly:
		return time.Date(current.Year(), current.Month(), 1, 0, 0, 0, 0, current.Location()).Unix()
	default:
		return 0
	}
}

// PeriodBudgetUsed 返回令牌在包含 now 的窗口内已消费的额度。窗口已过期时
// 返回 0：窗口滚动由下一次预扣落库，这个只读方法不写数据库。
func (token *Token) PeriodBudgetUsed(now int64) int {
	if !token.HasPeriodQuota() {
		return 0
	}
	if token.PeriodWindowStart != TokenPeriodWindowStart(token.PeriodResetPeriod, now) {
		return 0
	}
	return token.PeriodUsed
}

// PeriodBudgetExhausted 报告令牌在包含 now 的窗口内是否已用尽周期预算。
func (token *Token) PeriodBudgetExhausted(now int64) bool {
	return token.HasPeriodQuota() && token.PeriodBudgetUsed(now) >= token.PeriodQuota
}

// tokenPeriodConfigUpdate 决定配置更新如何影响周期窗口记账，返回随本次更新
// 额外写入的列（nil 表示保持不变）以及提交后的 PeriodUsed / PeriodWindowStart。
// 启用周期预算或更换重置周期时从当前窗口重新计数；禁用时清零；周期不变时保留
// 并发请求已累计的用量。
func tokenPeriodConfigUpdate(committed *Token, requested *Token, now int64) (map[string]any, int, int64) {
	if !requested.HasPeriodQuota() {
		if !committed.HasPeriodQuota() && committed.PeriodUsed == 0 && committed.PeriodWindowStart == 0 {
			return nil, committed.PeriodUsed, committed.PeriodWindowStart
		}
		return map[string]any{"period_used": 0, "period_window_start": 0}, 0, 0
	}
	if committed.PeriodResetPeriod != requested.PeriodResetPeriod || committed.PeriodQuota <= 0 {
		start := TokenPeriodWindowStart(requested.PeriodResetPeriod, now)
		return map[string]any{"period_used": 0, "period_window_start": start}, 0, start
	}
	return nil, committed.PeriodUsed, committed.PeriodWindowStart
}
