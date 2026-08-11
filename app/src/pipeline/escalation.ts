/**
 * Escalation ladder: determines which stage an overdue invoice is at
 * based on the number of days past due.
 *
 * Defaults (hardcoded ladder used by every merchant unless they set custom
 * Pro thresholds):
 *   Stage 1: 1–6 days  — friendly reminder
 *   Stage 2: 7–20 days — firmer follow-up
 *   Stage 3: 21+ days  — final notice
 *
 * Pro merchants may customize the boundaries via PUT /settings
 * (stage1_days / stage2_days); those values are validated so that
 * 1 <= stage1Max < stage2Max <= 90 and threaded through the watcher here.
 */

export function getEscalationStage(daysOverdue: number, stage1Max = 6, stage2Max = 20): 1 | 2 | 3 {
  if (daysOverdue <= 0) {
    return 1; // treat current / future as stage 1
  }
  if (daysOverdue <= stage1Max) return 1;
  if (daysOverdue <= stage2Max) return 2;
  return 3;
}

export function getEscalationLabel(stage: number): string {
  switch (stage) {
    case 1: return "Friendly reminder";
    case 2: return "Follow-up";
    case 3: return "Final notice";
    default: return "Unknown";
  }
}

export function getStageLabel(stage: number): string {
  switch (stage) {
    case 1: return "Day 1 - friendly";
    case 2: return "Day 7 - firm";
    case 3: return "Day 14 - final notice";
    default: return "Reminder";
  }
}

export function getStageSubjectPrefix(stage: number): string {
  switch (stage) {
    case 1: return "Quick reminder";
    case 2: return "Following up";
    case 3: return "Final notice";
    default: return "Reminder";
  }
}
