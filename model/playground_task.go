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

// CountActivePlaygroundTasks reports how many async generation tasks the
// account still has running. It backs the Playground task concurrency budget
// (`TaskMaxConcurrency`), which is an independent resource limit: the count
// reads the durable task rows and never touches User.Quota, UsedQuota or the
// token billing settlement path.
//
// A task is active until it reaches a terminal state, so a task whose result
// is being polled still consumes one slot.
func CountActivePlaygroundTasks(userID int) (int64, error) {
	if userID <= 0 {
		return 0, nil
	}
	var count int64
	err := DB.Model(&Task{}).
		Where("user_id = ?", userID).
		Where("status NOT IN ?", []TaskStatus{TaskStatusFailure, TaskStatusSuccess}).
		Count(&count).Error
	if err != nil {
		return 0, err
	}
	return count, nil
}
