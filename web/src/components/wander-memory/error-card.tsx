// ─────────────────────────────────────────────────────────────────────────────
// components/wander-memory/error-card.tsx — fail-closed error surface for
// collision_* and other fatal write errors (§5.4), ported from WanderMemory
// `web/app/src/components/shared.tsx` (ErrorCard) onto shared-ui Alert.
// The human message comes from the §5.4 treatment table (treatmentFor).
// ─────────────────────────────────────────────────────────────────────────────

import { Alert, Button } from "@hermes/shared-ui";
import { ApiError, treatmentFor } from "@/lib/wander-memory";
import s from "./error-card.module.css";

export interface ErrorCardProps {
  error: ApiError;
  /** Dismiss the card (route clears its error state). */
  onDismiss?: () => void;
  /** Re-run the failed operation. */
  retry?: () => void;
}

export function ErrorCard({ error, onDismiss, retry }: ErrorCardProps) {
  const treatment = treatmentFor(error);
  const actions = (
    <div className={s.actions}>
      {retry ? (
        <Button type="button" variant="outline" size="xs" onClick={retry}>
          重试
        </Button>
      ) : null}
      {onDismiss ? (
        <Button type="button" variant="plain" size="xs" aria-label="关闭" onClick={onDismiss}>
          ×
        </Button>
      ) : null}
    </div>
  );

  return (
    <Alert
      tone="danger"
      className={s.errorCard}
      title={`错误 ${error.code}${error.status ? `（HTTP ${error.status}）` : ""}`}
      actions={actions}
    >
      <span className={s.text}>{treatment.text}</span>
    </Alert>
  );
}
