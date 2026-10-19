package controller

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/setting/playground_setting"

	"github.com/gin-gonic/gin"
)

const playgroundLogReplayNotFoundMessage = "Playground log entry or retained request content not found."

func writePlaygroundLogNotFound(c *gin.Context) {
	common.ApiErrorStatus(c, http.StatusNotFound, common.NewMessage(playgroundLogReplayNotFoundMessage), gin.H{"code": "PLAYGROUND_NOT_FOUND"})
}

// resolvePlaygroundLogTarget returns the owner whose log the request may read.
// A user can only read their own logs; an administrator may read another
// account's log by passing user_id, and the caller records that read in the
// audit trail. Every refusal is indistinguishable from a missing log (404), so
// the endpoint never confirms that another account's log exists.
func resolvePlaygroundLogTarget(c *gin.Context) (targetUserId int, crossUser bool, ok bool) {
	callerUserId := c.GetInt("id")
	if callerUserId <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Authentication required."))
		return 0, false, false
	}
	raw := strings.TrimSpace(c.Query("user_id"))
	if raw == "" {
		return callerUserId, false, true
	}
	parsed, err := strconv.Atoi(raw)
	if err != nil || parsed <= 0 {
		writePlaygroundLogNotFound(c)
		return 0, false, false
	}
	if parsed == callerUserId {
		return callerUserId, false, true
	}
	if c.GetInt("role") < common.RoleAdminUser {
		writePlaygroundLogNotFound(c)
		return 0, false, false
	}
	return parsed, true, true
}

// GetPlaygroundLogReplay returns the replayable projection of one usage-log
// entry: the log metadata every owner already receives plus, while the optional
// capture is on and unexpired, the desensitized request/response summary. The
// client turns it into a draft and never sends it automatically. Reading
// another account's retained content as an administrator writes an audit row.
func GetPlaygroundLogReplay(c *gin.Context) {
	targetUserId, crossUser, ok := resolvePlaygroundLogTarget(c)
	if !ok {
		return
	}
	logRef := strings.TrimSpace(c.Param("logRef"))
	if logRef == "" {
		writePlaygroundLogNotFound(c)
		return
	}
	log, err := model.GetPlaygroundReplayLog(targetUserId, logRef)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if log == nil {
		writePlaygroundLogNotFound(c)
		return
	}
	capture, err := model.GetPlaygroundLogCapture(targetUserId, log.RequestId)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	replay := model.BuildPlaygroundLogReplay(log, capture, playground_setting.PlaygroundLogCaptureEnabled(), common.GetTimestamp())
	if replay == nil {
		writePlaygroundLogNotFound(c)
		return
	}
	if crossUser && replay.ContentAvailable {
		// The administrator just received content the owner wrote; that read
		// belongs to the operation audit trail.
		recordManageAuditFor(c, targetUserId, "playground.log_replay_view", map[string]any{
			"target_user_id": targetUserId,
			"request_id":     log.RequestId,
			"model":          log.ModelName,
		})
	}
	common.ApiSuccess(c, replay)
}

// DeletePlaygroundLogCapture removes the retained summary of one of the
// caller's own log entries. Turning the capture switch off stops new rows; this
// endpoint lets the owner delete an existing one before its window elapses.
func DeletePlaygroundLogCapture(c *gin.Context) {
	callerUserId := c.GetInt("id")
	if callerUserId <= 0 {
		common.ApiErrorStatus(c, http.StatusUnauthorized, common.NewMessage("Authentication required."))
		return
	}
	logRef := strings.TrimSpace(c.Param("logRef"))
	if logRef == "" {
		writePlaygroundLogNotFound(c)
		return
	}
	log, err := model.GetPlaygroundReplayLog(callerUserId, logRef)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	if log == nil {
		writePlaygroundLogNotFound(c)
		return
	}
	deleted, err := model.DeletePlaygroundLogCapture(callerUserId, log.RequestId)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	common.ApiSuccess(c, gin.H{"deleted": deleted})
}
