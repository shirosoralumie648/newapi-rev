package middleware

import (
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func newTokenAutoGroupsContext() *gin.Context {
	gin.SetMode(gin.TestMode)
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	return ctx
}

func TestSetupContextForTokenPreservesCustomAutoGroupsOrder(t *testing.T) {
	ctx := newTokenAutoGroupsContext()
	token := &model.Token{Id: 1, UserId: 2, AutoGroups: `["vip","default"]`}

	require.NoError(t, SetupContextForToken(ctx, token))
	value, ok := common.GetContextKey(ctx, constant.ContextKeyTokenAutoGroups)
	require.True(t, ok)
	assert.Equal(t, []string{"vip", "default"}, value)
}

func TestSetupContextForTokenTreatsStoredEmptyArrayAsInheritance(t *testing.T) {
	ctx := newTokenAutoGroupsContext()
	token := &model.Token{Id: 1, UserId: 2, AutoGroups: `[]`}

	require.NoError(t, SetupContextForToken(ctx, token))
	_, ok := common.GetContextKey(ctx, constant.ContextKeyTokenAutoGroups)
	assert.False(t, ok)
}

func TestSetupContextForTokenMalformedAutoGroupsFailsClosed(t *testing.T) {
	ctx := newTokenAutoGroupsContext()
	token := &model.Token{Id: 1, UserId: 2, AutoGroups: `not-json`}

	require.NoError(t, SetupContextForToken(ctx, token))
	value, ok := common.GetContextKey(ctx, constant.ContextKeyTokenAutoGroups)
	require.True(t, ok)
	assert.Equal(t, []string{}, value)
}

func TestSetupContextForTokenCarriesAdmissionLimits(t *testing.T) {
	ctx := newTokenAutoGroupsContext()
	token := &model.Token{Id: 1, UserId: 2, RPMLimit: 12, TPMLimit: 34}

	require.NoError(t, SetupContextForToken(ctx, token))
	assert.Equal(t, 12, common.GetContextKeyInt(ctx, constant.ContextKeyTokenRPMLimit))
	assert.Equal(t, 34, common.GetContextKeyInt(ctx, constant.ContextKeyTokenTPMLimit))
}

func TestSetupContextForTokenOmitsUnlimitedAdmissionLimits(t *testing.T) {
	ctx := newTokenAutoGroupsContext()

	require.NoError(t, SetupContextForToken(ctx, &model.Token{Id: 1, UserId: 2}))
	_, rpmSet := common.GetContextKey(ctx, constant.ContextKeyTokenRPMLimit)
	_, tpmSet := common.GetContextKey(ctx, constant.ContextKeyTokenTPMLimit)
	assert.False(t, rpmSet)
	assert.False(t, tpmSet)
}
