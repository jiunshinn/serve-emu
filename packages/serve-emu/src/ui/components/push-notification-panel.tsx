import { useId, useState } from "react";
import { apiErrorMessage, apiRequest } from "../lib/api-client";

/** Reads `key=value` lines into push data; the first `=` ends the key. */
function dataFromLines(text: string): Record<string, string> | undefined {
  const data: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const split = line.indexOf("=");
    if (split <= 0) throw new Error(`Data line "${line.trim()}" needs key=value`);
    data[line.slice(0, split).trim()] = line.slice(split + 1);
  }
  return Object.keys(data).length > 0 ? data : undefined;
}

export function PushNotificationPanel() {
  const [packageName, setPackageName] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [link, setLink] = useState("");
  const [data, setData] = useState("");
  const [status, setStatus] = useState("Ready");
  const packageId = useId();

  const run = async (label: string, request: () => Promise<{ output: string }>) => {
    setStatus(`${label}...`);
    try {
      setStatus((await request()).output || "OK");
    } catch (err) {
      setStatus(apiErrorMessage(err));
    }
  };

  const fillForegroundApp = () =>
    void run("Reading foreground app", async () => {
      const { app } = await apiRequest("/api/foreground", { method: "GET", cache: "no-store" });
      if (!app.packageName) throw new Error("No foreground app");
      setPackageName(app.packageName);
      return { output: `Using ${app.packageName}` };
    });

  const sendPush = () =>
    void run("Sending push", () =>
      apiRequest("/api/apps/push", {
        method: "POST",
        body: {
          packageName: packageName.trim(),
          title: title || undefined,
          body: body || undefined,
          link: link.trim() || undefined,
          data: dataFromLines(data),
        },
      }),
    );

  const openLink = () =>
    void run("Opening link", async () => {
      const { output } = await apiRequest("/api/deep-link", {
        method: "POST",
        body: { url: link.trim(), packageName: packageName.trim() || undefined },
      });
      // `am start -W` names the activity that took the link.
      const activity = /^Activity: (.+)$/m.exec(output)?.[1];
      return { output: activity ? `Opened ${activity}` : output };
    });

  return (
    <section aria-label="Push and deep link controls" className="tool-panel push-panel">
      <div className="panel-heading">
        <h2>Push & Deep Links</h2>
        <div className="location-status" role="status">
          {status}
        </div>
      </div>
      <div className="stacked-field">
        <label htmlFor={packageId}>Package</label>
        <div className="field-with-action">
          <input
            id={packageId}
            onChange={(e) => setPackageName(e.currentTarget.value)}
            placeholder="com.example.app"
            value={packageName}
          />
          <button type="button" onClick={fillForegroundApp}>
            Foreground
          </button>
        </div>
      </div>
      <label className="stacked-field">
        Title
        <input onChange={(e) => setTitle(e.currentTarget.value)} placeholder="Order shipped" value={title} />
      </label>
      <label className="stacked-field">
        Body
        <textarea onChange={(e) => setBody(e.currentTarget.value)} placeholder="Tap to track it" rows={2} value={body} />
      </label>
      <label className="stacked-field">
        Deep link
        <input
          onChange={(e) => setLink(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) openLink();
          }}
          placeholder="myapp://orders/42"
          value={link}
        />
      </label>
      <label className="stacked-field">
        Data (key=value per line)
        <textarea onChange={(e) => setData(e.currentTarget.value)} placeholder="orderId=42" rows={2} value={data} />
      </label>
      <div className="panel-actions push-actions">
        <button className="primary-action" onClick={sendPush}>
          Send Push
        </button>
        <button onClick={openLink}>Open Link</button>
      </div>
      <small className="panel-hint">
        Push simulates FCM and needs a Google APIs emulator image. Without a title or body it is a
        data message. Open Link sends the link to the package when one is set.
      </small>
    </section>
  );
}
