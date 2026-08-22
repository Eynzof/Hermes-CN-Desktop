/**
 * Simple Mixture-of-Agents status panel.
 *
 * Displays the reference outputs and the final aggregator/council report.
 */

import type { JSX } from "react";
import type { MoaReferenceResult, TokenUsage } from "@hermes/agent-core";
import styles from "./moa-panel.module.css";

export interface MoaPanelProps {
  title?: string;
  references?: MoaReferenceResult[];
  aggregatorModel?: string;
  output?: string;
  usage?: TokenUsage;
  isLoading?: boolean;
}

export function MoaPanel({
  title = "Mixture of Agents",
  references = [],
  aggregatorModel,
  output,
  usage,
  isLoading,
}: MoaPanelProps): JSX.Element {
  return (
    <div className={styles.panel} data-testid="moa-panel">
      <div className={styles.title}>{title}</div>

      {references.length > 0 && (
        <>
          <div className={styles.subtitle}>
            Reference outputs ({references.length})
          </div>
          {references.map((ref, i) => (
            <div key={`${ref.name}-${i}`} className={styles.reference}>
              <div className={styles.referenceLabel}>
                {ref.name} ({ref.provider}/{ref.model})
              </div>
              <div className={styles.referenceText}>{ref.text}</div>
            </div>
          ))}
        </>
      )}

      {aggregatorModel && (
        <div className={styles.subtitle}>
          Aggregator: {aggregatorModel}
        </div>
      )}

      {output && <div className={styles.output}>{output}</div>}

      {usage && (
        <div className={styles.subtitle}>
          Tokens: {usage.input} in / {usage.output} out
        </div>
      )}

      {isLoading && <div className={styles.loading}>Running ensemble…</div>}
    </div>
  );
}
