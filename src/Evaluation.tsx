import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from './research';
import type { Session } from './model';

type Result = { claim: string; metrics: NonNullable<Session['analysis']> };
const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 });
type Benchmark = {
  cases: number;
  classificationCases: number;
  dataset: string;
  model: string;
  metrics: Record<string, number | null>;
};
export function Evaluation() {
  const [data, setData] = useState<{
    runs: Result[];
    benchmarks: Benchmark[];
    judgments: { total: number; grounded: number; agreed: number };
  }>();
  const [error, setError] = useState('');
  useEffect(() => {
    api<typeof data>('evaluation')
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <div className="standard-page">
      <header className="page-intro">
        <span className="page-symbol">
          <ShieldCheck />
        </span>
        <h1>Evaluation</h1>
        <p>Retrieval and citation checks from completed model runs.</p>
      </header>
      {error && <p className="form-error">{error}</p>}
      {!data && !error && <p>Loading measurements…</p>}
      {data?.benchmarks?.map(benchmark => (
        <section key={benchmark.dataset} className="surface form-card">
          <h2>{benchmark.dataset}</h2>
          <p>
            {benchmark.cases} retrieval cases · {benchmark.classificationCases > 0 ? benchmark.classificationCases + ' classification cases · ' : ''}{benchmark.model}
          </p>
          <dl className="source-facts">
            {Object.entries(benchmark.metrics).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value === null ? 'No eligible cases' : (value * 100).toFixed(1) + '%'}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      {data?.judgments && (
        <section className="surface form-card">
          <h2>Human passage reviews</h2>
          {data.judgments.total ? (
            <p>
              {data.judgments.total} judged findings ·{' '}
              {((100 * data.judgments.grounded) / data.judgments.total).toFixed(1)}% citation precision ·{' '}
              {(100 * (1 - data.judgments.grounded / data.judgments.total)).toFixed(1)}% unsupported ·{' '}
              {((100 * data.judgments.agreed) / data.judgments.total).toFixed(1)}% stance agreement
            </p>
          ) : (
            <p>
              Review an AI finding and its original quote to measure citation precision and stance
              agreement in this workspace.
            </p>
          )}
        </section>
      )}
      <section className="surface form-card">
        <h2>Investigation measurements</h2>
        {!data?.runs.length && (
          <p>Completed AI investigations appear here with their measured latency and token usage.</p>
        )}
        {data?.runs.map(({ claim, metrics }, i) => (
          <div className="form-section" key={i}>
            <h3>{claim}</h3>
            <p>
              {metrics.model} · {Math.round(metrics.elapsedMs / 1000)} seconds · {metrics.calls}{' '}
              generation calls
            </p>
            <p>
              {metrics.indexed} indexed chunks · {metrics.retrieved.length} retrieved ·{' '}
              {metrics.verified} of {metrics.proposed} proposed findings passed citation checks
            </p>
            <p>
              {metrics.inputTokens} input tokens · {metrics.outputTokens} output tokens
              {metrics.thinkingTokens ? ' · ' + metrics.thinkingTokens + ' reasoning tokens' : ''}
              {metrics.embeddingTokens ? ' · ' + metrics.embeddingTokens + ' embedding tokens' : ''}
            </p>
            {metrics.cost && <p>{metrics.cost.estimatedUsd === null
              ? 'Generation cost unavailable for ' + metrics.cost.unpricedCalls + ' unpriced calls'
              : 'Estimated generation API cost ' + dollars.format(metrics.cost.estimatedUsd)}</p>}
          </div>
        ))}
      </section>
    </div>
  );
}
