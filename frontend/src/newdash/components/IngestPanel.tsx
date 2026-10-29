import { Plug } from "lucide-react";
import type { ChannelDef } from "../types";

interface Props { channels: ChannelDef[]; keyRequired: boolean }

export function IngestPanel({ channels, keyRequired }: Props) {
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:8000";
  const example = channels.slice(0, 4).map((c) => `    "${c.id}": 0`).join(",\n");
  const curl = `curl -X POST "${origin}/api/ingest" \\\n  -H "Content-Type: application/json" \\${keyRequired ? '\n  -H "X-API-Key: <your key>" \\' : ""}\n  -d '{"source": "plc-1", "values": {\n${example},\n    ...\n  }}'`;
  return (
    <section className="panel" aria-labelledby="ingest-h">
      <h2 id="ingest-h" className="panel-title"><Plug size={16} aria-hidden="true" /> Send your own readings</h2>
      <p className="fine">
        POST one reading (or <code>{"{\"readings\": [...]}"}</code>) every few seconds to <code>/api/ingest</code>. Readings are averaged into one-minute bins.
        Missing channels are held for 5 minutes, then flagged. Send <code>ts</code> in ISO 8601, or the server uses its own clock.
      </p>
      <pre className="code" tabIndex={0}>{curl}</pre>
      <details className="recent">
        <summary>Channel names and units ({channels.length})</summary>
        <table className="channel-table">
          <tbody>
            {channels.map((c) => (
              <tr key={c.id}><td><code>{c.id}</code></td><td>{c.label}</td><td className="muted">{c.unit}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
