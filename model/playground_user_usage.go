/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
package model

import (
	"errors"
	"slices"

	"github.com/QuantumNous/new-api/common"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// PlaygroundUserUsage is one account's cached Playground resource counters.
//
// Every Playground write transaction locks this single row (lockForUpdate) and
// keeps the counters exact inside the same transaction that writes the
// resource. Capacity checks therefore never aggregate the stored rows and never
// lock the `users` row the relay pipeline uses for quota settlement, so a busy
// workspace no longer contends with billing.
//
// The counters are derived state, not user data: they can be recomputed from
// the rows that own the resources. The row is created lazily by the first write
// of an account (or by the daily reconciliation), and the reconciliation buys
// back any drift by writing the measured values without touching, deleting or
// moving a single resource.
type PlaygroundUserUsage struct {
	UserID   int   `json:"user_id" gorm:"primaryKey"`
	Sessions int64 `json:"sessions" gorm:"not null"`
	Presets  int64 `json:"presets" gorm:"not null"`
	// Snippets counts the account's stored prompt snippets. The column was
	// appended to a counter table that already holds rows, so it carries the
	// same DEFAULT 0 as the canvas snapshot counters: a NOT NULL column can
	// only be added to a non-empty table when it has one.
	Snippets        int64 `json:"snippets" gorm:"not null;default:0"`
	AttachmentCount int64 `json:"attachment_count" gorm:"not null"`
	// AttachmentBytes counts every stored attachment byte, database-backed
	// legacy rows included, because that is the budget AttachmentUserMaxBytes
	// enforces.
	AttachmentBytes int64 `json:"attachment_bytes" gorm:"not null"`
	// ObjectBytes counts the attachment bytes that live in the object store,
	// the durable footprint later storage accounting builds on.
	ObjectBytes int64 `json:"object_bytes" gorm:"not null"`
	// AttachmentPendingCount and AttachmentPendingBytes count the in-flight
	// presigned upload reservations: bytes no attachment row owns yet, but
	// which the account's budgets already reserve, so concurrent uploads can
	// never overrun the limits the committed counters enforce.
	AttachmentPendingCount int64 `json:"attachment_pending_count" gorm:"not null;default:0"`
	AttachmentPendingBytes int64 `json:"attachment_pending_bytes" gorm:"not null;default:0"`
	ArtifactCount          int64 `json:"artifact_count" gorm:"not null"`
	ArtifactBytes          int64 `json:"artifact_bytes" gorm:"not null"`
	CanvasCount            int64 `json:"canvas_count" gorm:"not null"`
	CanvasBytes            int64 `json:"canvas_bytes" gorm:"not null"`
	// CanvasSnapshotCount and CanvasSnapshotBytes count the gzip canvas
	// history objects of the account. They are separate from CanvasBytes so
	// the board budgets and the history budget never trade one for the other,
	// and the handlers that add columns to an existing installation rely on
	// the DEFAULT 0, which keeps the migrated columns non-null.
	CanvasSnapshotCount int64 `json:"canvas_snapshot_count" gorm:"not null;default:0"`
	CanvasSnapshotBytes int64 `json:"canvas_snapshot_bytes" gorm:"not null;default:0"`
	// KnowledgeBaseCount, KnowledgeBaseDocumentCount, KnowledgeBaseChunkCount
	// and KnowledgeBaseBytes count the account's knowledge bases, their
	// documents, the stored embedding chunks and the logical bytes (source
	// file, extracted text and chunk text plus vectors). The four columns were
	// appended to an existing table, so they carry DEFAULT 0 like the other
	// later counters.
	KnowledgeBaseCount         int64 `json:"knowledge_base_count" gorm:"not null;default:0"`
	KnowledgeBaseDocumentCount int64 `json:"knowledge_base_document_count" gorm:"not null;default:0"`
	KnowledgeBaseChunkCount    int64 `json:"knowledge_base_chunk_count" gorm:"not null;default:0"`
	KnowledgeBaseBytes         int64 `json:"knowledge_base_bytes" gorm:"not null;default:0"`
	CreatedAt                  int64 `json:"created_at" gorm:"not null"`
	UpdatedAt                  int64 `json:"updated_at" gorm:"not null"`
}

// TableName pins the table name the plan defines; GORM would otherwise
// pluralize the model name.
func (PlaygroundUserUsage) TableName() string {
	return "playground_user_usage"
}

// playgroundUserUsageCounters is the comparable snapshot of one counter row
// without identity and timestamps.
type playgroundUserUsageCounters struct {
	Sessions                   int64
	Presets                    int64
	Snippets                   int64
	AttachmentCount            int64
	AttachmentBytes            int64
	ObjectBytes                int64
	AttachmentPendingCount     int64
	AttachmentPendingBytes     int64
	ArtifactCount              int64
	ArtifactBytes              int64
	CanvasCount                int64
	CanvasBytes                int64
	CanvasSnapshotCount        int64
	CanvasSnapshotBytes        int64
	KnowledgeBaseCount         int64
	KnowledgeBaseDocumentCount int64
	KnowledgeBaseChunkCount    int64
	KnowledgeBaseBytes         int64
}

func (usage *PlaygroundUserUsage) counters() playgroundUserUsageCounters {
	return playgroundUserUsageCounters{
		Sessions:                   usage.Sessions,
		Presets:                    usage.Presets,
		Snippets:                   usage.Snippets,
		AttachmentCount:            usage.AttachmentCount,
		AttachmentBytes:            usage.AttachmentBytes,
		ObjectBytes:                usage.ObjectBytes,
		AttachmentPendingCount:     usage.AttachmentPendingCount,
		AttachmentPendingBytes:     usage.AttachmentPendingBytes,
		ArtifactCount:              usage.ArtifactCount,
		ArtifactBytes:              usage.ArtifactBytes,
		CanvasCount:                usage.CanvasCount,
		CanvasBytes:                usage.CanvasBytes,
		CanvasSnapshotCount:        usage.CanvasSnapshotCount,
		CanvasSnapshotBytes:        usage.CanvasSnapshotBytes,
		KnowledgeBaseCount:         usage.KnowledgeBaseCount,
		KnowledgeBaseDocumentCount: usage.KnowledgeBaseDocumentCount,
		KnowledgeBaseChunkCount:    usage.KnowledgeBaseChunkCount,
		KnowledgeBaseBytes:         usage.KnowledgeBaseBytes,
	}
}

// load copies measured counters onto the row.
func (usage *PlaygroundUserUsage) load(counters playgroundUserUsageCounters) {
	usage.Sessions = counters.Sessions
	usage.Presets = counters.Presets
	usage.Snippets = counters.Snippets
	usage.AttachmentCount = counters.AttachmentCount
	usage.AttachmentBytes = counters.AttachmentBytes
	usage.ObjectBytes = counters.ObjectBytes
	usage.AttachmentPendingCount = counters.AttachmentPendingCount
	usage.AttachmentPendingBytes = counters.AttachmentPendingBytes
	usage.ArtifactCount = counters.ArtifactCount
	usage.ArtifactBytes = counters.ArtifactBytes
	usage.CanvasCount = counters.CanvasCount
	usage.CanvasBytes = counters.CanvasBytes
	usage.CanvasSnapshotCount = counters.CanvasSnapshotCount
	usage.CanvasSnapshotBytes = counters.CanvasSnapshotBytes
	usage.KnowledgeBaseCount = counters.KnowledgeBaseCount
	usage.KnowledgeBaseDocumentCount = counters.KnowledgeBaseDocumentCount
	usage.KnowledgeBaseChunkCount = counters.KnowledgeBaseChunkCount
	usage.KnowledgeBaseBytes = counters.KnowledgeBaseBytes
}

// playgroundUserUsageDelta is a signed change applied to a locked counter row.
// A decrease is clamped at zero, so a replay or an unexpected double delete can
// never push a counter below zero.
type playgroundUserUsageDelta struct {
	Sessions                   int64
	Presets                    int64
	Snippets                   int64
	AttachmentCount            int64
	AttachmentBytes            int64
	ObjectBytes                int64
	AttachmentPendingCount     int64
	AttachmentPendingBytes     int64
	ArtifactCount              int64
	ArtifactBytes              int64
	CanvasCount                int64
	CanvasBytes                int64
	CanvasSnapshotCount        int64
	CanvasSnapshotBytes        int64
	KnowledgeBaseCount         int64
	KnowledgeBaseDocumentCount int64
	KnowledgeBaseChunkCount    int64
	KnowledgeBaseBytes         int64
}

func (usage *PlaygroundUserUsage) apply(delta playgroundUserUsageDelta) {
	usage.Sessions = max(0, usage.Sessions+delta.Sessions)
	usage.Presets = max(0, usage.Presets+delta.Presets)
	usage.Snippets = max(0, usage.Snippets+delta.Snippets)
	usage.AttachmentCount = max(0, usage.AttachmentCount+delta.AttachmentCount)
	usage.AttachmentBytes = max(0, usage.AttachmentBytes+delta.AttachmentBytes)
	usage.ObjectBytes = max(0, usage.ObjectBytes+delta.ObjectBytes)
	usage.AttachmentPendingCount = max(0, usage.AttachmentPendingCount+delta.AttachmentPendingCount)
	usage.AttachmentPendingBytes = max(0, usage.AttachmentPendingBytes+delta.AttachmentPendingBytes)
	usage.ArtifactCount = max(0, usage.ArtifactCount+delta.ArtifactCount)
	usage.ArtifactBytes = max(0, usage.ArtifactBytes+delta.ArtifactBytes)
	usage.CanvasCount = max(0, usage.CanvasCount+delta.CanvasCount)
	usage.CanvasBytes = max(0, usage.CanvasBytes+delta.CanvasBytes)
	usage.CanvasSnapshotCount = max(0, usage.CanvasSnapshotCount+delta.CanvasSnapshotCount)
	usage.CanvasSnapshotBytes = max(0, usage.CanvasSnapshotBytes+delta.CanvasSnapshotBytes)
	usage.KnowledgeBaseCount = max(0, usage.KnowledgeBaseCount+delta.KnowledgeBaseCount)
	usage.KnowledgeBaseDocumentCount = max(0, usage.KnowledgeBaseDocumentCount+delta.KnowledgeBaseDocumentCount)
	usage.KnowledgeBaseChunkCount = max(0, usage.KnowledgeBaseChunkCount+delta.KnowledgeBaseChunkCount)
	usage.KnowledgeBaseBytes = max(0, usage.KnowledgeBaseBytes+delta.KnowledgeBaseBytes)
}

// lockPlaygroundUserUsage acquires the account's counter row for the rest of
// the surrounding transaction. The row is created on first use by measuring the
// stored rows, and the insert is idempotent so two transactions initializing
// the same account cannot fail each other.
func lockPlaygroundUserUsage(tx *gorm.DB, userID int) (*PlaygroundUserUsage, error) {
	if userID <= 0 {
		return nil, gorm.ErrRecordNotFound
	}
	var usage PlaygroundUserUsage
	err := lockForUpdate(tx).Where("user_id = ?", userID).First(&usage).Error
	if err == nil {
		return &usage, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	now := common.GetTimestamp()
	snapshot, err := playgroundUserUsageSnapshot(tx, userID)
	if err != nil {
		return nil, err
	}
	snapshot.UserID = userID
	snapshot.CreatedAt = now
	snapshot.UpdatedAt = now
	// DoNothing keeps a concurrent initializer's row; the locking read below
	// then observes it instead of failing the transaction.
	if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&snapshot).Error; err != nil {
		return nil, err
	}
	if err := lockForUpdate(tx).Where("user_id = ?", userID).First(&usage).Error; err != nil {
		return nil, err
	}
	return &usage, nil
}

// savePlaygroundUserUsage stores every counter of a locked row. The caller
// holds the row lock, so writing absolute values is exact.
func savePlaygroundUserUsage(tx *gorm.DB, usage *PlaygroundUserUsage) error {
	usage.UpdatedAt = common.GetTimestamp()
	return tx.Model(&PlaygroundUserUsage{}).Where("user_id = ?", usage.UserID).Updates(map[string]any{
		"sessions":                      usage.Sessions,
		"presets":                       usage.Presets,
		"snippets":                      usage.Snippets,
		"attachment_count":              usage.AttachmentCount,
		"attachment_bytes":              usage.AttachmentBytes,
		"object_bytes":                  usage.ObjectBytes,
		"attachment_pending_count":      usage.AttachmentPendingCount,
		"attachment_pending_bytes":      usage.AttachmentPendingBytes,
		"artifact_count":                usage.ArtifactCount,
		"artifact_bytes":                usage.ArtifactBytes,
		"canvas_count":                  usage.CanvasCount,
		"canvas_bytes":                  usage.CanvasBytes,
		"canvas_snapshot_count":         usage.CanvasSnapshotCount,
		"canvas_snapshot_bytes":         usage.CanvasSnapshotBytes,
		"knowledge_base_count":          usage.KnowledgeBaseCount,
		"knowledge_base_document_count": usage.KnowledgeBaseDocumentCount,
		"knowledge_base_chunk_count":    usage.KnowledgeBaseChunkCount,
		"knowledge_base_bytes":          usage.KnowledgeBaseBytes,
		"updated_at":                    usage.UpdatedAt,
	}).Error
}

// playgroundUserUsageSnapshot measures every counter from the stored rows. It
// is the source of truth the lazy initialization and the daily reconciliation
// compare against.
func playgroundUserUsageSnapshot(tx *gorm.DB, userID int) (PlaygroundUserUsage, error) {
	usage := PlaygroundUserUsage{UserID: userID}
	if err := tx.Model(&PlaygroundSession{}).Where("user_id = ?", userID).Count(&usage.Sessions).Error; err != nil {
		return usage, err
	}
	if err := tx.Model(&PlaygroundPreset{}).Where("user_id = ?", userID).Count(&usage.Presets).Error; err != nil {
		return usage, err
	}
	if err := tx.Model(&PlaygroundSnippet{}).Where("user_id = ?", userID).Count(&usage.Snippets).Error; err != nil {
		return usage, err
	}
	var attachments struct {
		Used        int64
		UsedBytes   int64
		ObjectBytes int64
	}
	if err := tx.Model(&PlaygroundAttachment{}).Where("user_id = ?", userID).
		Select("COUNT(*) AS used, COALESCE(SUM(byte_size), 0) AS used_bytes, COALESCE(SUM(CASE WHEN storage_backend IS NOT NULL AND storage_backend <> ? AND storage_backend <> '' THEN byte_size ELSE 0 END), 0) AS object_bytes", playgroundAttachmentStorageDatabase).
		Scan(&attachments).Error; err != nil {
		return usage, err
	}
	usage.AttachmentCount, usage.AttachmentBytes, usage.ObjectBytes = attachments.Used, attachments.UsedBytes, attachments.ObjectBytes
	// Pending reservations are measured from their own rows: a reservation is
	// quota held, never data, so it is counted separately from the attachments.
	var pending struct {
		Used      int64
		UsedBytes int64
	}
	if err := tx.Model(&PlaygroundUpload{}).Where("user_id = ?", userID).
		Select("COUNT(*) AS used, COALESCE(SUM(byte_size), 0) AS used_bytes").Scan(&pending).Error; err != nil {
		return usage, err
	}
	usage.AttachmentPendingCount, usage.AttachmentPendingBytes = pending.Used, pending.UsedBytes
	// Only live artifacts count: a tombstoned artifact has had its versions
	// removed, so it no longer occupies the account budget.
	if err := tx.Model(&PlaygroundArtifact{}).Where("user_id = ? AND deleted_at = 0", userID).Count(&usage.ArtifactCount).Error; err != nil {
		return usage, err
	}
	var artifactBytes struct {
		UsedBytes int64
	}
	if err := tx.Model(&PlaygroundArtifactVersion{}).
		Where("artifact_id IN (?)", tx.Model(&PlaygroundArtifact{}).Select("id").Where("user_id = ?", userID)).
		Select("COALESCE(SUM(byte_size), 0) AS used_bytes").Scan(&artifactBytes).Error; err != nil {
		return usage, err
	}
	usage.ArtifactBytes = artifactBytes.UsedBytes
	var canvas struct {
		Used      int64
		UsedBytes int64
	}
	if err := tx.Model(&PlaygroundCanvasProject{}).Where("user_id = ?", userID).
		Select("COUNT(*) AS used, COALESCE(SUM(document_bytes), 0) AS used_bytes").Scan(&canvas).Error; err != nil {
		return usage, err
	}
	usage.CanvasCount, usage.CanvasBytes = canvas.Used, canvas.UsedBytes
	// Snapshot bytes are the logical (uncompressed) document bytes packed into
	// the gzip history objects, which is what the snapshot budget weighs.
	var snapshots struct {
		Used      int64
		UsedBytes int64
	}
	if err := tx.Model(&PlaygroundCanvasSnapshot{}).Where("user_id = ?", userID).
		Select("COUNT(*) AS used, COALESCE(SUM(byte_size), 0) AS used_bytes").Scan(&snapshots).Error; err != nil {
		return usage, err
	}
	usage.CanvasSnapshotCount, usage.CanvasSnapshotBytes = snapshots.Used, snapshots.UsedBytes
	if err := tx.Model(&PlaygroundKnowledgeBase{}).Where("user_id = ?", userID).Count(&usage.KnowledgeBaseCount).Error; err != nil {
		return usage, err
	}
	var knowledge struct {
		DocumentCount int64
		DocumentBytes int64
		TextBytes     int64
	}
	if err := tx.Model(&PlaygroundKnowledgeDocument{}).Where("user_id = ?", userID).
		Select("COUNT(*) AS document_count, COALESCE(SUM(byte_size), 0) AS document_bytes, COALESCE(SUM(text_bytes), 0) AS text_bytes").
		Scan(&knowledge).Error; err != nil {
		return usage, err
	}
	var knowledgeChunks struct {
		ChunkCount int64
		ChunkBytes int64
	}
	if err := tx.Model(&PlaygroundKnowledgeChunk{}).Where("user_id = ?", userID).
		Select("COUNT(*) AS chunk_count, COALESCE(SUM(byte_size), 0) AS chunk_bytes").
		Scan(&knowledgeChunks).Error; err != nil {
		return usage, err
	}
	usage.KnowledgeBaseDocumentCount = knowledge.DocumentCount
	usage.KnowledgeBaseChunkCount = knowledgeChunks.ChunkCount
	usage.KnowledgeBaseBytes = knowledge.DocumentBytes + knowledge.TextBytes + knowledgeChunks.ChunkBytes
	return usage, nil
}

// readPlaygroundUserUsage reads the stored counters of one account. An
// account that never wrote since the counters were introduced is measured on
// the fly; the read path never writes.
func readPlaygroundUserUsage(userID int) (PlaygroundUserUsage, error) {
	var usage PlaygroundUserUsage
	err := DB.Where("user_id = ?", userID).First(&usage).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return playgroundUserUsageSnapshot(DB, userID)
	}
	return usage, err
}

// PlaygroundUsageRepair records one repaired account: the counters that were
// stored and the values measured from the rows.
type PlaygroundUsageRepair struct {
	UserID int                 `json:"user_id"`
	Stored PlaygroundUserUsage `json:"stored"`
	Actual PlaygroundUserUsage `json:"actual"`
}

// PlaygroundUsageReconciliation summarizes one counter reconciliation run.
// Repairs is capped so the report stays bounded; RepairedCount is the full
// count.
type PlaygroundUsageReconciliation struct {
	CheckedAt     int64                   `json:"checked_at"`
	UserCount     int64                   `json:"user_count"`
	RepairedCount int64                   `json:"repaired_count"`
	Repairs       []PlaygroundUsageRepair `json:"repairs"`
}

// playgroundUsageOwnerIDs lists the accounts that store Playground resources,
// so reconciliation also initializes counter rows for accounts that predate
// them.
func playgroundUsageOwnerIDs(db *gorm.DB) ([]int, error) {
	seen := map[int]bool{}
	for _, resource := range []any{&PlaygroundSession{}, &PlaygroundPreset{}, &PlaygroundSnippet{}, &PlaygroundAttachment{}, &PlaygroundUpload{}, &PlaygroundArtifact{}, &PlaygroundCanvasProject{}, &PlaygroundCanvasSnapshot{}, &PlaygroundKnowledgeBase{}} {
		ids := make([]int, 0)
		if err := db.Model(resource).Distinct("user_id").Pluck("user_id", &ids).Error; err != nil {
			return nil, err
		}
		for _, id := range ids {
			if id > 0 {
				seen[id] = true
			}
		}
	}
	owners := make([]int, 0, len(seen))
	for id := range seen {
		owners = append(owners, id)
	}
	slices.Sort(owners)
	return owners, nil
}

// reconcilePlaygroundUserUsageTx remeasures one account inside tx and repairs
// its counter row when it drifted, returning the repair (nil when the stored
// counters were already exact).
func reconcilePlaygroundUserUsageTx(tx *gorm.DB, userID int) (*PlaygroundUsageRepair, error) {
	stored, err := lockPlaygroundUserUsage(tx, userID)
	if err != nil {
		return nil, err
	}
	actual, err := playgroundUserUsageSnapshot(tx, userID)
	if err != nil {
		return nil, err
	}
	if stored.counters() == actual.counters() {
		return nil, nil
	}
	before := *stored
	stored.load(actual.counters())
	if err := savePlaygroundUserUsage(tx, stored); err != nil {
		return nil, err
	}
	return &PlaygroundUsageRepair{UserID: userID, Stored: before, Actual: actual}, nil
}

// refreshPlaygroundUserUsage remeasures the counters of one account inside tx.
// Cascade deletes use it because a conversation release removes attachments,
// artifacts and messages at once; mirroring every removed row would repeat the
// work one measurement already does.
func refreshPlaygroundUserUsage(tx *gorm.DB, userID int) error {
	_, err := reconcilePlaygroundUserUsageTx(tx, userID)
	return err
}

// ReconcilePlaygroundUserUsage recomputes the counters of every account that
// stores Playground resources and repairs the rows that drifted. The counters
// are derived state, so the repair writes the measured values back and never
// touches, deletes or moves a stored resource. reportLimit caps how many
// repaired accounts one report lists.
func ReconcilePlaygroundUserUsage(reportLimit int) (*PlaygroundUsageReconciliation, error) {
	report := &PlaygroundUsageReconciliation{
		CheckedAt: common.GetTimestamp(),
		Repairs:   make([]PlaygroundUsageRepair, 0),
	}
	owners, err := playgroundUsageOwnerIDs(DB)
	if err != nil {
		return nil, err
	}
	for _, userID := range owners {
		report.UserCount++
		var repair *PlaygroundUsageRepair
		err := DB.Transaction(func(tx *gorm.DB) error {
			repaired, err := reconcilePlaygroundUserUsageTx(tx, userID)
			repair = repaired
			return err
		})
		if err != nil {
			return nil, err
		}
		if repair == nil {
			continue
		}
		report.RepairedCount++
		if len(report.Repairs) < reportLimit {
			report.Repairs = append(report.Repairs, *repair)
		}
	}
	return report, nil
}
