package model

import (
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

func TestUpdateEmailTemplates(t *testing.T) {
	database, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("gorm.Open() error = %v", err)
	}
	if err = database.AutoMigrate(&Option{}); err != nil {
		t.Fatalf("AutoMigrate() error = %v", err)
	}
	sqlDatabase, err := database.DB()
	if err != nil {
		t.Fatalf("database.DB() error = %v", err)
	}
	t.Cleanup(func() {
		_ = sqlDatabase.Close()
	})

	originalDB := DB
	DB = database
	t.Cleanup(func() {
		DB = originalDB
	})

	common.OptionMapRWMutex.Lock()
	originalOptionMap := common.OptionMap
	originalVerificationSubject := common.EmailVerificationSubject
	originalVerificationContent := common.EmailVerificationContent
	originalPasswordResetSubject := common.PasswordResetSubject
	originalPasswordResetContent := common.PasswordResetContent
	common.OptionMap = make(map[string]string)
	common.OptionMapRWMutex.Unlock()
	t.Cleanup(func() {
		common.OptionMapRWMutex.Lock()
		defer common.OptionMapRWMutex.Unlock()
		common.OptionMap = originalOptionMap
		common.EmailVerificationSubject = originalVerificationSubject
		common.EmailVerificationContent = originalVerificationContent
		common.PasswordResetSubject = originalPasswordResetSubject
		common.PasswordResetContent = originalPasswordResetContent
	})

	values := map[string]string{
		common.EmailVerificationSubjectOption: "verification subject",
		common.EmailVerificationContentOption: "verification {{code}}",
		common.PasswordResetSubjectOption:     "reset subject",
		common.PasswordResetContentOption:     "reset {{reset_link}}",
	}
	if err = UpdateEmailTemplates(values); err != nil {
		t.Fatalf("UpdateEmailTemplates() error = %v", err)
	}

	var options []Option
	if err = database.Find(&options).Error; err != nil {
		t.Fatalf("Find() error = %v", err)
	}
	if len(options) != len(values) {
		t.Fatalf("saved option count = %d, want %d", len(options), len(values))
	}
	for key, value := range values {
		if common.OptionMap[key] != value {
			t.Errorf("OptionMap[%q] = %q, want %q", key, common.OptionMap[key], value)
		}
	}
	if common.EmailVerificationContent != values[common.EmailVerificationContentOption] ||
		common.PasswordResetContent != values[common.PasswordResetContentOption] {
		t.Fatalf("configured template globals were not updated")
	}

	if err = database.Exec("DELETE FROM options").Error; err != nil {
		t.Fatalf("delete saved options error = %v", err)
	}
	if err = database.Exec(`
		CREATE TRIGGER reject_password_reset_template
		BEFORE INSERT ON options
		WHEN NEW.key = 'PasswordResetSubject'
		BEGIN
			SELECT RAISE(ABORT, 'injected template save failure');
		END;
	`).Error; err != nil {
		t.Fatalf("create failure trigger error = %v", err)
	}
	common.OptionMapRWMutex.Lock()
	for key := range values {
		common.OptionMap[key] = "before failed update"
	}
	common.EmailVerificationSubject = "before failed update"
	common.EmailVerificationContent = "before failed update"
	common.PasswordResetSubject = "before failed update"
	common.PasswordResetContent = "before failed update"
	common.OptionMapRWMutex.Unlock()

	if err = UpdateEmailTemplates(values); err == nil {
		t.Fatal("UpdateEmailTemplates() expected an injected database error")
	}
	var optionCount int64
	if err = database.Model(&Option{}).Count(&optionCount).Error; err != nil {
		t.Fatalf("Count() error = %v", err)
	}
	if optionCount != 0 {
		t.Fatalf("saved option count after rollback = %d, want 0", optionCount)
	}
	common.OptionMapRWMutex.RLock()
	defer common.OptionMapRWMutex.RUnlock()
	for key := range values {
		if common.OptionMap[key] != "before failed update" {
			t.Errorf("OptionMap[%q] changed after rollback", key)
		}
	}
	if common.EmailVerificationContent != "before failed update" ||
		common.PasswordResetContent != "before failed update" {
		t.Fatal("configured template globals changed after rollback")
	}
}
