"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Card,
  CardSkeleton,
  ConfirmModal,
  Input,
  Modal,
  Select,
} from "@/shared/components";

const PROVIDER_ID = "antigravity-cli";
const API = `/api/providers/${PROVIDER_ID}/containers`;
const FAMILY_LABELS = { gemini: "Gemini", claude_gpt: "Claude/GPT", gemini_argon: "Argon" };

function statusBadge(connection) {
  const error = String(connection.lastError || "");
  const errorCode = Number(connection.errorCode || 0);
  const banned = errorCode === 403
    || /AGY_ACCOUNT_DISABLED|violation of Terms|terms of service|banned|account.*disabled|permission denied/i.test(error);
  if (banned) {
    return <Badge variant="error" size="sm" dot>Suspended</Badge>;
  }
  if (connection.isActive === false) {
    return <Badge variant="default" size="sm" dot>Disabled</Badge>;
  }
  const containerState = connection.container?.state;
  if (containerState && containerState !== "running") {
    return <Badge variant="warning" size="sm" dot>{containerState}</Badge>;
  }
  if (connection.testStatus === "active") {
    return <Badge variant="success" size="sm" dot>Ready</Badge>;
  }
  if (connection.testStatus === "unavailable") {
    if (errorCode === 401 || /login|auth|token|sign in/i.test(error)) {
      return <Badge variant="warning" size="sm" dot>Needs login</Badge>;
    }
    return <Badge variant="warning" size="sm" dot>{errorCode ? `Error ${errorCode}` : "Unavailable"}</Badge>;
  }
  return <Badge variant="default" size="sm" dot>Unknown</Badge>;
}

export default function AntigravityCliPage() {
  const [docker, setDocker] = useState(null);
  const [connections, setConnections] = useState([]);
  const [proxyPools, setProxyPools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [pageError, setPageError] = useState("");
  const [form, setForm] = useState({ name: "", proxyPoolId: "__none__", imageTag: "1.5.9", memory: "256m", cpus: "1" });
  const [creating, setCreating] = useState(false);
  const [edit, setEdit] = useState(null);
  const [login, setLogin] = useState(null);
  const [logs, setLogs] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [quotas, setQuotas] = useState({});
  const [quotaBusy, setQuotaBusy] = useState(null);
  const [checks, setChecks] = useState({});

  const load = useCallback(async () => {
    try {
      const [dockerRes, containersRes, proxiesRes] = await Promise.all([
        fetch("/api/docker", { cache: "no-store" }),
        fetch(API, { cache: "no-store" }),
        fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }),
      ]);
      const dockerJson = dockerRes.ok ? await dockerRes.json() : { ready: false, error: "Cannot read Docker status" };
      const containersJson = containersRes.ok ? await containersRes.json() : { connections: [] };
      const proxiesJson = proxiesRes.ok ? await proxiesRes.json() : { proxyPools: [] };
      setDocker(dockerJson);
      setConnections(containersJson.connections || []);
      setProxyPools(proxiesJson.proxyPools || []);
    } catch (error) {
      setPageError(error?.message || "Failed to load provider state");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll so a background ban/error (written by markAccountUnavailable) shows
  // up without a manual Refresh. Quota tracker already refreshes separately.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) load();
    }, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  const setupDocker = async () => {
    setBusy("docker");
    setPageError("");
    try {
      const res = await fetch("/api/docker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoInstall: true }),
      });
      const json = await res.json();
      setDocker(json);
      if (!json.ready) setPageError(json.error || "Docker is not ready yet");
    } catch (error) {
      setPageError(error?.message || "Docker setup failed");
    } finally {
      setBusy(null);
    }
  };

  const createContainer = async (event) => {
    event.preventDefault();
    setCreating(true);
    setPageError("");
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          proxyPoolId: form.proxyPoolId === "__none__" ? null : form.proxyPoolId,
          imageTag: form.imageTag.trim() || undefined,
          memory: form.memory.trim() || undefined,
          cpus: Number(form.cpus) || 1,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setPageError(json.error || "Failed to create container");
        if (json.docker) setDocker(json.docker);
        return;
      }
      setForm({ name: "", proxyPoolId: "__none__", imageTag: "1.5.9", memory: "256m", cpus: "1" });
      await load();
      if (json.health?.authOk === false) {
        setPageError("Container is ready but agy is not signed in yet — open Login.");
      }
    } catch (error) {
      setPageError(error?.message || "Failed to create container");
    } finally {
      setCreating(false);
    }
  };

  const runAction = async (id, action) => {
    setBusy(`${action}:${id}`);
    setPageError("");
    try {
      const res = await fetch(`${API}/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (!res.ok) setPageError(json.error || `${action} failed`);
      await load();
    } catch (error) {
      setPageError(error?.message || `${action} failed`);
    } finally {
      setBusy(null);
    }
  };

  const toggleActive = async (connection) => {
    setBusy(`toggle:${connection.id}`);
    setPageError("");
    try {
      const res = await fetch(`/api/providers/${connection.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !connection.isActive }),
      });
      const json = await res.json();
      if (!res.ok) setPageError(json.error || "Failed to update account");
      await load();
    } catch (error) {
      setPageError(error?.message || "Failed to update account");
    } finally {
      setBusy(null);
    }
  };

  const testConnection = async (id) => {
    setBusy(`test:${id}`);
    setPageError("");
    try {
      const res = await fetch(`${API}/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test" }),
      });
      const json = await res.json();
      setChecks((prev) => ({
        ...prev,
        [id]: res.ok ? json : { ok: false, status: res.status, error: json.error || "Test failed" },
      }));
      await load();
    } catch (error) {
      setChecks((prev) => ({ ...prev, [id]: { ok: false, status: 0, error: error?.message || "Test failed" } }));
    } finally {
      setBusy(null);
    }
  };

  const openEdit = (connection) => {
    const current = connection.providerSpecificData?.proxyPoolId || null;
    const currentMemory = connection.providerSpecificData?.memory || "256m";
    const currentCpus = String(connection.providerSpecificData?.cpus || 1);
    const currentImageTag = connection.providerSpecificData?.imageTag
      || String(connection.providerSpecificData?.image || "9router/agy-gateway:1.5.9").split(":").pop();
    setEdit({
      id: connection.id,
      name: connection.name || "",
      proxyPoolId: current || "__none__",
      originalProxyPoolId: current,
      memory: currentMemory,
      cpus: currentCpus,
      originalMemory: currentMemory,
      originalCpus: currentCpus,
      imageTag: currentImageTag,
      originalImageTag: currentImageTag,
      saving: false,
    });
  };

  const saveEdit = async () => {
    if (!edit || !edit.name.trim()) return;
    setEdit((prev) => ({ ...prev, saving: true }));
    setPageError("");
    try {
      const res = await fetch(`${API}/${edit.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          name: edit.name.trim(),
          proxyPoolId: edit.proxyPoolId === "__none__" ? null : edit.proxyPoolId,
          memory: edit.memory.trim() || "256m",
          cpus: Number(edit.cpus) || 1,
          imageTag: edit.imageTag.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setPageError(json.error || "Update failed");
        setEdit((prev) => ({ ...prev, saving: false }));
        return;
      }
      setEdit(null);
      await load();
    } catch (error) {
      setPageError(error?.message || "Update failed");
      setEdit((prev) => ({ ...prev, saving: false }));
    }
  };

  const proxyName = (id) => proxyPools.find((pool) => pool.id === id)?.name || null;

  const openLogs = async (id) => {
    setBusy(`logs:${id}`);
    try {
      const res = await fetch(`${API}/${id}?logs=1&tail=300`, { cache: "no-store" });
      const json = await res.json();
      setLogs({ id, text: res.ok ? json.logs || "(empty)" : json.error || "Failed to read logs" });
    } catch (error) {
      setLogs({ id, text: error?.message || "Failed to read logs" });
    } finally {
      setBusy(null);
    }
  };

  const loadQuota = async (id) => {
    setQuotaBusy(id);
    try {
      const res = await fetch(
        `/api/providers/${PROVIDER_ID}/usage?connectionId=${encodeURIComponent(id)}&force=1`,
        { cache: "no-store" },
      );
      const json = await res.json();
      setQuotas((prev) => ({ ...prev, [id]: res.ok ? json : { error: json.error || "Failed to read quota" } }));
    } catch (error) {
      setQuotas((prev) => ({ ...prev, [id]: { error: error?.message || "Failed to read quota" } }));
    } finally {
      setQuotaBusy(null);
    }
  };

  const startLogin = async (id) => {
    setBusy(`login:${id}`);
    setPageError("");
    try {
      const res = await fetch(`/api/providers/${id}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      const json = await res.json();
      if (!res.ok) {
        setPageError(json.error || "Failed to start login");
        return;
      }
      setLogin({ id, url: json.url || "", input: "" });
    } catch (error) {
      setPageError(error?.message || "Failed to start login");
    } finally {
      setBusy(null);
    }
  };

  const completeLogin = async () => {
    if (!login?.input?.trim()) return;
    setBusy(`login-complete:${login.id}`);
    setPageError("");
    try {
      const res = await fetch(`/api/providers/${login.id}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "complete", input: login.input.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        setPageError(json.error || "Login failed");
        return;
      }
      setLogin(null);
      await load();
    } catch (error) {
      setPageError(error?.message || "Login failed");
    } finally {
      setBusy(null);
    }
  };

  const removeConnection = (connection) => {
    setConfirm({
      title: "Delete container",
      message: `Delete "${connection.name}" and its container? The /data volume (login) is kept by Docker unless you remove it manually.`,
      confirmText: "Delete",
      loading: false,
      onConfirm: async () => {
        setConfirm((prev) => ({ ...prev, loading: true }));
        try {
          await fetch(`${API}/${connection.id}`, { method: "DELETE" });
          setConfirm(null);
          await load();
        } catch (error) {
          setPageError(error?.message || "Delete failed");
          setConfirm(null);
        }
      },
    });
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const editNextProxy = edit ? (edit.proxyPoolId === "__none__" ? null : edit.proxyPoolId) : null;
  const editProxyChanged = Boolean(edit) && editNextProxy !== (edit.originalProxyPoolId || null);
  const editNextMemory = edit ? edit.memory.trim() || "256m" : "256m";
  const editNextCpus = edit ? String(Number(edit.cpus) || 1) : "1";
  const editImageChanged = Boolean(edit)
    && (edit.imageTag.trim() || "") !== (edit.originalImageTag || "");
  const editResourcesChanged = Boolean(edit)
    && (editNextMemory !== (edit.originalMemory || "256m") || editNextCpus !== (edit.originalCpus || "1"));
  const editNeedsRecreate = editProxyChanged || editResourcesChanged || editImageChanged;

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      <div className="flex flex-col gap-2">
        <Link href="/dashboard/providers" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-primary">
          <span className="material-symbols-outlined text-[18px]">arrow_back</span>
          Providers
        </Link>
        <h1 className="text-xl font-semibold text-text-main">Antigravity CLI</h1>
        <p className="max-w-3xl text-sm text-text-muted">
          One Docker container per account runs the official <code className="font-mono">agy</code> CLI. 9router only relays
          OpenAI-compatible requests, so no IDE impersonation is involved. Each container keeps its own login in a{" "}
          <code className="font-mono">/data</code> volume and can use its own proxy.
        </p>
      </div>

      {pageError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
          {pageError}
        </div>
      )}

      <Card title="Docker" padding="sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
            {docker?.ready ? (
              <Badge variant="success" size="sm" dot>Ready{docker.version ? ` · ${docker.version}` : ""}</Badge>
            ) : docker?.installed ? (
              <Badge variant="warning" size="sm" dot>Installed, not usable</Badge>
            ) : (
              <Badge variant="error" size="sm" dot>Not installed</Badge>
            )}
            {docker?.error && <span className="text-xs">{docker.error}</span>}
          </div>
          <Button
            size="sm"
            variant={docker?.ready ? "secondary" : "primary"}
            icon="settings_suggest"
            loading={busy === "docker"}
            onClick={setupDocker}
          >
            {docker?.ready ? "Re-check Docker" : "Set up Docker"}
          </Button>
        </div>
        {!docker?.ready && Array.isArray(docker?.manualCommands) && (
          <pre className="mt-3 overflow-x-auto rounded-lg bg-black/[0.04] p-3 text-xs leading-relaxed dark:bg-white/[0.04]">
            {docker.manualCommands.join("\n")}
          </pre>
        )}
      </Card>

      <Card title="Add account container" padding="sm">
        <form onSubmit={createContainer} className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Account name"
            placeholder="agy-01"
            required
            value={form.name}
            onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
          />
          <Select
            label="Proxy pool"
            value={form.proxyPoolId}
            onChange={(event) => setForm((prev) => ({ ...prev, proxyPoolId: event.target.value }))}
            options={[
              { value: "__none__", label: "Direct (no proxy)" },
              ...proxyPools.map((pool) => ({ value: pool.id, label: pool.name })),
            ]}
            hint={
              <>
                Each account keeps its own pool.{" "}
                <Link href="/dashboard/proxy-pools" className="text-primary hover:underline">
                  Manage proxy pools
                </Link>
                .
              </>
            }
          />
          <Input
            label="Image tag"
            value={form.imageTag}
            onChange={(event) => setForm((prev) => ({ ...prev, imageTag: event.target.value }))}
            hint="Must match the agy version baked into the image."
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Memory"
              value={form.memory}
              onChange={(event) => setForm((prev) => ({ ...prev, memory: event.target.value }))}
              hint="256m is enough for light use; raise it for heavy tool sessions."
            />
            <Input
              label="CPUs"
              type="number"
              min="0.1"
              step="0.1"
              value={form.cpus}
              onChange={(event) => setForm((prev) => ({ ...prev, cpus: event.target.value }))}
            />
          </div>
          <div className="sm:col-span-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-text-muted">
              Creating a container can take up to a minute (pull + health check). Login happens afterwards.
            </p>
            <Button type="submit" icon="add" loading={creating} disabled={!form.name.trim() || !docker?.ready}>
              Create container
            </Button>
          </div>
        </form>
      </Card>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-main">Accounts ({connections.length})</h2>
          <Button size="sm" variant="ghost" icon="refresh" onClick={load}>Refresh</Button>
        </div>

        {connections.length === 0 ? (
          <Card>
            <p className="py-6 text-center text-sm text-text-muted">No accounts yet. Create a container above.</p>
          </Card>
        ) : (
          connections.map((connection) => {
            const data = connection.providerSpecificData || {};
            const isBusy = busy?.endsWith(`:${connection.id}`);
            return (
              <Card key={connection.id} padding="sm">
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-mono text-sm font-medium">{connection.name}</span>
                        {statusBadge(connection)}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                        {data.loginEmail && <span>{data.loginEmail}</span>}
                        <span>port {data.hostPort || "?"}</span>
                        <span className="truncate">{data.image || "image ?"}</span>
                        <span>{data.proxyPoolId ? `proxy ${proxyName(data.proxyPoolId) || String(data.proxyPoolId).slice(0, 8)}` : "direct"}</span>
                        <span>{data.memory || "?"} · {data.cpus || 1} CPU</span>
                        {connection.container?.status && <span>{connection.container.status}</span>}
                        {connection.errorCode ? <span className="text-red-500">HTTP {connection.errorCode}</span> : null}
                      </div>
                      {connection.lastError && (
                        <p className="mt-1 line-clamp-2 text-xs text-red-500">{connection.lastError}</p>
                      )}
                      {checks[connection.id] && (
                        <p className={`mt-1 text-xs ${checks[connection.id].ok ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>
                          Test {checks[connection.id].ok
                            ? `OK${checks[connection.id].model ? ` · ${checks[connection.id].model}` : ""}`
                            : `failed${checks[connection.id].status ? ` (${checks[connection.id].status})` : ""}: ${checks[connection.id].error || "unknown error"}`}
                        </p>
                      )}
                      {quotas[connection.id]?.quotas && (
                        <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-text-muted">
                          {Object.entries(quotas[connection.id].quotas).flatMap(([family, windows]) =>
                            (windows || []).map((window) => (
                              <span
                                key={`${family}-${window.bucketId}`}
                                className="rounded bg-black/5 px-1.5 py-0.5 dark:bg-white/5"
                              >
                                {FAMILY_LABELS[family] || family} · {window.window || "?"}{" "}
                                {window.remainingPercentage == null ? "?" : `${Math.round(window.remainingPercentage)}%`}
                                {window.resetAt ? ` · reset ${new Date(window.resetAt).toLocaleString()}` : ""}
                              </span>
                            )),
                          )}
                        </div>
                      )}
                      {quotas[connection.id]?.error && (
                        <p className="mt-1 text-xs text-red-500">{quotas[connection.id].error}</p>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-wrap gap-1.5">
                      <Button size="xs" variant="primary" icon="login" loading={busy === `login:${connection.id}`} onClick={() => startLogin(connection.id)}>
                        Login
                      </Button>
                      <Button size="xs" variant="secondary" icon="edit" onClick={() => openEdit(connection)}>
                        Edit
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        icon={connection.isActive ? "pause" : "play_arrow"}
                        loading={busy === `toggle:${connection.id}`}
                        onClick={() => toggleActive(connection)}
                      >
                        {connection.isActive ? "Disable" : "Enable"}
                      </Button>
                      <Button size="xs" variant="secondary" icon="sync" loading={busy === `recreate:${connection.id}`} disabled={isBusy && busy !== `recreate:${connection.id}`} onClick={() => runAction(connection.id, "recreate")}>
                        Recreate
                      </Button>
                      <Button size="xs" variant="secondary" icon="restart_alt" loading={busy === `restart:${connection.id}`} onClick={() => runAction(connection.id, "restart")}>
                        Restart
                      </Button>
                      <Button size="xs" variant="ghost" icon="science" loading={busy === `test:${connection.id}`} onClick={() => testConnection(connection.id)}>
                        Test
                      </Button>
                      <Button size="xs" variant="ghost" icon="speed" loading={quotaBusy === connection.id} onClick={() => loadQuota(connection.id)}>
                        Quota
                      </Button>
                      <Button size="xs" variant="ghost" icon="terminal" loading={busy === `logs:${connection.id}`} onClick={() => openLogs(connection.id)}>
                        Logs
                      </Button>
                      <Button size="xs" variant="danger" icon="delete" onClick={() => removeConnection(connection)}>
                        Delete
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })
        )}
      </div>

      <Modal
        isOpen={Boolean(login)}
        onClose={() => setLogin(null)}
        title="Login Antigravity CLI"
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setLogin(null)}>Cancel</Button>
            <Button
              onClick={completeLogin}
              loading={busy === `login-complete:${login?.id}`}
              disabled={!login?.input?.trim()}
            >
              Complete login
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-text-muted">
            Open this link, sign in with the account that should own this container, then paste the authorization code
            (or the full callback URL) below.
          </p>
          <a
            href={login?.url || "#"}
            target="_blank"
            rel="noreferrer"
            className="break-all rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 font-mono text-xs text-primary hover:border-primary"
          >
            {login?.url || "Waiting for agy to print the URL…"}
          </a>
          <Input
            label="Authorization code or callback URL"
            placeholder="4/0A..."
            value={login?.input || ""}
            onChange={(event) => setLogin((prev) => ({ ...prev, input: event.target.value }))}
          />
          <p className="text-xs text-text-muted">
            The code is single-use and expires in about 10 minutes. If it fails, press Login again.
          </p>
        </div>
      </Modal>

      <Modal
        isOpen={Boolean(edit)}
        onClose={() => !edit?.saving && setEdit(null)}
        title="Edit account"
        footer={
          <>
            <Button variant="ghost" disabled={edit?.saving} onClick={() => setEdit(null)}>Cancel</Button>
            <Button onClick={saveEdit} loading={edit?.saving} disabled={!edit?.name?.trim()}>
              {editNeedsRecreate ? "Save & recreate" : "Save"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Input
            label="Account name"
            value={edit?.name || ""}
            onChange={(event) => setEdit((prev) => ({ ...prev, name: event.target.value }))}
          />
          <Select
            label="Proxy pool"
            value={edit?.proxyPoolId || "__none__"}
            onChange={(event) => setEdit((prev) => ({ ...prev, proxyPoolId: event.target.value }))}
            options={[
              { value: "__none__", label: "Direct (no proxy)" },
              ...(edit?.originalProxyPoolId && !proxyName(edit.originalProxyPoolId)
                ? [{ value: edit.originalProxyPoolId, label: `Missing pool (${String(edit.originalProxyPoolId).slice(0, 8)})` }]
                : []),
              ...proxyPools.map((pool) => ({ value: pool.id, label: pool.name })),
            ]}
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Memory"
              value={edit?.memory || ""}
              onChange={(event) => setEdit((prev) => ({ ...prev, memory: event.target.value }))}
              hint="e.g. 256m, 512m, 1g"
            />
            <Input
              label="CPUs"
              type="number"
              min="0.1"
              step="0.1"
              value={edit?.cpus || ""}
              onChange={(event) => setEdit((prev) => ({ ...prev, cpus: event.target.value }))}
            />
          </div>
          <Input
            label="Image tag"
            value={edit?.imageTag || ""}
            onChange={(event) => setEdit((prev) => ({ ...prev, imageTag: event.target.value }))}
            hint="Must match the agy version baked into the image."
          />
          {editNeedsRecreate ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              Changing the proxy, image tag, memory or CPUs recreates this account&apos;s container (about a minute). The <code className="font-mono">/data</code>{" "}
              volume keeps the login session, so you should not need to sign in again.
            </div>
          ) : (
            <p className="text-xs text-text-muted">
              Proxy, image tag, memory and CPUs are applied at container create time. Editing a pool&apos;s URL only takes effect after Recreate.
            </p>
          )}
        </div>
      </Modal>

      <Modal
        isOpen={Boolean(logs)}
        onClose={() => setLogs(null)}
        title="Container logs"
        size="full"
        footer={<Button variant="ghost" onClick={() => setLogs(null)}>Close</Button>}
      >
        <pre className="max-h-[60vh] overflow-auto rounded-lg bg-black/[0.05] p-3 text-xs leading-relaxed dark:bg-white/[0.05]">
          {logs?.text || ""}
        </pre>
      </Modal>

      <ConfirmModal
        isOpen={Boolean(confirm)}
        onClose={() => !confirm?.loading && setConfirm(null)}
        onConfirm={confirm?.onConfirm}
        title={confirm?.title}
        message={confirm?.message}
        confirmText={confirm?.confirmText}
        loading={Boolean(confirm?.loading)}
      />
    </div>
  );
}
