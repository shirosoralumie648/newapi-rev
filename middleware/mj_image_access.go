package middleware

import (
	"github.com/QuantumNous/new-api/service"
	"github.com/QuantumNous/new-api/setting"

	"github.com/gin-gonic/gin"
)

// MjImageAccessControl guards GET /mj/image/:id. The route must stay outside
// TokenAuth because forwarded image links are loaded by browsers and MjProxy
// clients as a plain image source, without any Authorization header.
//
// The accepted proof depends on setting.MjImageAccessMode:
//
//   - auth (default): a dashboard session or an API token is required, and the
//     handler limits the read to the task owner (administrators keep the
//     dashboard-wide view).
//   - signed: an unexpired HMAC minted by this server grants access on its own,
//     so links already handed to clients keep working; requests without a valid
//     signature fall back to the auth rules above.
//   - legacy: the historical open access, kept only for links that were already
//     issued to clients.
func MjImageAccessControl() gin.HandlerFunc {
	authenticate := TokenOrUserAuth()
	return func(c *gin.Context) {
		switch setting.NormalizeMjImageAccessMode(setting.MjImageAccessMode) {
		case setting.MjImageAccessLegacy:
			c.Next()
			return
		case setting.MjImageAccessSigned:
			if service.VerifyMjImageSignature(c.Param("id"), c.Query(service.MjImageSignatureQueryParameter), c.Query(service.MjImageExpiryQueryParameter)) {
				c.Next()
				return
			}
		}
		authenticate(c)
	}
}
