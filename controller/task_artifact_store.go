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
package controller

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	relaychannel "github.com/QuantumNous/new-api/relay/channel"
	"github.com/QuantumNous/new-api/service"
)

// playgroundTaskArtifactStoreInterval is how often the store pass runs. One
// pass handles a few tasks, so a burst of finished generations is drained over
// consecutive runs without blocking task polling.
const playgroundTaskArtifactStoreInterval = time.Minute

// playgroundTaskArtifactStoreHandler pulls the provider results of finished
// workspace tasks into the object store. Plugin tasks are listed through their
// adaptor (the same projection the artifact endpoints use) and legacy video
// tasks through their stored result URL, so the workspace has one persistence
// path for every generation shape.
type playgroundTaskArtifactStoreHandler struct{}

func (playgroundTaskArtifactStoreHandler) Type() string {
	return model.SystemTaskTypePlaygroundTaskArtifactStore
}

func (playgroundTaskArtifactStoreHandler) Enabled() bool {
	if !service.TaskArtifactStoreConfigured() {
		return false
	}
	cutoff := common.GetTimestamp() - int64(service.TaskArtifactRetention().Seconds())
	hasWork, err := model.HasPlaygroundTasksAwaitingArtifacts(cutoff)
	if err != nil {
		return false
	}
	return hasWork
}

func (playgroundTaskArtifactStoreHandler) Interval() time.Duration {
	return playgroundTaskArtifactStoreInterval
}

func (playgroundTaskArtifactStoreHandler) NewPayload() any { return nil }

func (playgroundTaskArtifactStoreHandler) Run(ctx context.Context, task *model.SystemTask, runnerID string) {
	summary, err := service.StorePendingPlaygroundTaskArtifacts(ctx, playgroundTaskArtifactStoreCollector{}, 0)
	if err != nil && !errors.Is(err, service.ErrTaskArtifactStoreDisabled) {
		finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusFailed, summary, err)
		return
	}
	finishSystemTaskHandler(task, runnerID, model.SystemTaskStatusSucceeded, summary, nil)
}

// playgroundTaskArtifactStoreCollector implements the service store pass with
// the relay adaptors and the legacy result URL. Credentials never leave the
// adaptor: the collector only forwards the request descriptor it built.
type playgroundTaskArtifactStoreCollector struct{}

func (playgroundTaskArtifactStoreCollector) ListTaskArtifacts(task *model.Task) ([]model.PlaygroundTaskArtifactSeed, error) {
	if task == nil || task.Status != model.TaskStatusSuccess || !task.ResultRetrievable() {
		return nil, nil
	}
	if !taskHasPluginExecution(task) {
		if legacyVideoAvailable(task) {
			return []model.PlaygroundTaskArtifactSeed{{Key: "video", Type: "video"}}, nil
		}
		return nil, nil
	}
	artifacts, err := projectTaskArtifacts(task)
	if err != nil {
		return nil, err
	}
	seeds := make([]model.PlaygroundTaskArtifactSeed, 0, len(artifacts))
	for _, artifact := range artifacts {
		seeds = append(seeds, model.PlaygroundTaskArtifactSeed{
			Key:      artifact.Key,
			Type:     artifact.Type,
			MimeType: artifact.MimeType,
		})
	}
	return seeds, nil
}

func (playgroundTaskArtifactStoreCollector) BuildTaskArtifactRequest(ctx context.Context, task *model.Task, artifactKey string) (*service.TaskArtifactSource, error) {
	if task == nil {
		return nil, errTaskArtifactPluginUnavailable
	}
	if !taskHasPluginExecution(task) {
		if artifactKey != "video" || !legacyVideoAvailable(task) {
			return nil, errTaskArtifactPluginUnavailable
		}
		return &service.TaskArtifactSource{
			URL:            task.GetResultURL(),
			Method:         http.MethodGet,
			Credentialless: true,
		}, nil
	}
	adaptor, err := initTaskArtifactAdaptor(task)
	if err != nil {
		return nil, err
	}
	provider, ok := adaptor.(relaychannel.TaskContentRequestProvider)
	if !ok {
		return nil, errTaskArtifactPluginUnavailable
	}
	descriptor, err := provider.BuildContentRequest(ctx, task, artifactKey, relaychannel.TaskArtifactClientRequest{Method: http.MethodGet})
	if err != nil {
		return nil, err
	}
	if descriptor == nil {
		return nil, fmt.Errorf("%w: artifact content plugin returned no request", errTaskArtifactPluginUnavailable)
	}
	return &service.TaskArtifactSource{
		URL:            descriptor.URL,
		Method:         descriptor.Method,
		Headers:        descriptor.Headers,
		Body:           descriptor.Body,
		Credentialless: descriptor.Credentialless,
	}, nil
}
