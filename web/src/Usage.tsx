import { useEffect, useState } from "react";
import { api, type UsageBucket, type UsageReport } from "./api.ts";

const money = (value: number) =>
  value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;

const number = (value: number) => value.toLocaleString("ru-RU");

function Period({ label, bucket }: { label: string; bucket: UsageBucket }) {
  return (
    <section className="period">
      <h3>
        {label} <span className="sum">{money(bucket.cost)}</span>
      </h3>
      <dl>
        <div><dt>Вход</dt><dd>{number(bucket.input)}</dd></div>
        <div><dt>Выход</dt><dd>{number(bucket.output)}</dd></div>
        <div><dt>Запись в кэш</dt><dd>{number(bucket.cacheWrite)}</dd></div>
        <div><dt>Чтение из кэша</dt><dd>{number(bucket.cacheRead)}</dd></div>
        <div><dt>Ответов</dt><dd>{number(bucket.replies)}</dd></div>
      </dl>
      {bucket.unpricedModels.length > 0 && (
        <p className="warn">
          Без цены в pricing.json: {[...new Set(bucket.unpricedModels)].join(", ")}
        </p>
      )}
    </section>
  );
}

export function Usage({ onClose }: { onClose: () => void }) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.usage().then(setReport).catch((e) => setError(String(e)));
  }, []);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Расходы</h2>
          <button onClick={onClose}>Закрыть</button>
        </header>
        {error && <p className="error">{error}</p>}
        {!report && !error && <p className="hint">Считаю…</p>}
        {report && (
          <>
            <Period label="Сегодня" bucket={report.today} />
            <Period label="Последние 24 часа" bucket={report.last24h} />
            <Period label="Последние 7 дней" bucket={report.last7d} />
            <p className="hint small">
              Токены мышления входят в «выход» и тарифицируются как выход.
              Цены — в файле pricing.json.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
