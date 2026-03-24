import React, { useState, useEffect, useCallback } from "react";
import { Check, AlertCircle, Info } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectGroup, SelectTrigger, SelectContent, SelectItem, SelectValue } from "../../components/ui/select";
import { Alert, AlertTitle } from "../../components/ui/alert";
import { Separator } from "../../components/ui/separator";
import { ScrollArea } from "../../components/ui/scroll-area";

const PROVIDERS = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
  { value: "ollama", label: "Ollama (local)" },
];

const FALLBACK_DEFAULTS: Record<string, { model: string; baseUrl: string }> = {
  anthropic: { model: "claude-sonnet-4-20250514", baseUrl: "https://api.anthropic.com" },
  openai: { model: "gpt-4o", baseUrl: "https://api.openai.com/v1" },
  gemini: { model: "gemini-2.5-flash", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  ollama: { model: "llama3", baseUrl: "http://localhost:11434" },
};

export function SettingsPanel() {
  const [provider, setProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [port, setPort] = useState("8787");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ text: string; level: string }>({ text: "", level: "" });
  const [providerDefaults, setProviderDefaults] = useState(FALLBACK_DEFAULTS);

  useEffect(() => {
    window.browserwire.getSettings().then((settings) => {
      if (settings.provider) setProvider(settings.provider);
      if (settings.model) setModel(settings.model);
      if (settings.baseUrl) setBaseUrl(settings.baseUrl);
      if (settings.port) setPort(String(settings.port));
      setHasApiKey(settings.hasApiKey);
      if (settings.providerDefaults) setProviderDefaults(settings.providerDefaults);

      if (settings.llmConfigured) {
        setStatus({ text: `Configured (${settings.provider || "unknown"})`, level: "ok" });
      } else {
        setStatus({ text: "Not configured", level: "warn" });
      }
    }).catch(() => {
      setStatus({ text: "Failed to load settings", level: "err" });
    });
  }, []);

  const defaults = providerDefaults[provider];

  const handleSave = useCallback(async () => {
    setSaving(true);
    setStatus({ text: "Saving...", level: "" });

    try {
      const payload: any = {
        provider: provider || undefined,
        apiKey: apiKey || undefined,
        model: model || undefined,
        baseUrl: baseUrl || undefined,
        port: port ? Number(port) : undefined,
      };

      const result = await window.browserwire.saveSettings(payload);

      if (result.ok) {
        if (apiKey) {
          setApiKey("");
          setHasApiKey(true);
        }

        if (result.llmConfigured) {
          setStatus({ text: `Configured (${provider || "unknown"})`, level: "ok" });
        } else {
          setStatus({ text: "Saved (LLM not fully configured)", level: "warn" });
        }
      } else {
        setStatus({ text: `Error: ${result.error || "unknown"}`, level: "err" });
      }
    } catch (err: any) {
      setStatus({ text: `Save failed: ${err.message}`, level: "err" });
    } finally {
      setSaving(false);
    }
  }, [provider, apiKey, model, baseUrl, port]);

  return (
    <ScrollArea className="flex-1">
      <div className="max-w-lg mx-auto p-4 flex flex-col gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Settings
        </h2>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="llm-provider" className="text-muted-foreground">LLM Provider</Label>
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger id="llm-provider">
              <SelectValue placeholder="Select provider..." />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="api-key" className="text-muted-foreground">API Key</Label>
          <Input
            id="api-key"
            type="password"
            placeholder={hasApiKey ? "Key saved (enter new to replace)" : "Enter API key..."}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          {hasApiKey && !apiKey && (
            <p className="text-xs text-muted-foreground">Saved securely in Keychain</p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="model" className="text-muted-foreground">Model</Label>
          <Input
            id="model"
            placeholder={defaults?.model || ""}
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Leave blank to use provider default.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="base-url" className="text-muted-foreground">Base URL</Label>
          <Input
            id="base-url"
            placeholder={defaults?.baseUrl || ""}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Only needed for custom/proxy endpoints.
          </p>
        </div>

        <Separator className="my-1" />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="server-port" className="text-muted-foreground">Server Port</Label>
          <Input
            id="server-port"
            type="number"
            min={1}
            max={65535}
            placeholder="8787"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Restart required after changing the port.
          </p>
        </div>

        <Button className="mt-2 w-full" disabled={saving} onClick={handleSave}>
          Save Settings
        </Button>

        {status.text && status.level === "ok" && (
          <Alert variant="success">
            <Check className="size-4" />
            <AlertTitle>{status.text}</AlertTitle>
          </Alert>
        )}

        {status.text && status.level === "warn" && (
          <Alert>
            <Info className="size-4" />
            <AlertTitle>{status.text}</AlertTitle>
          </Alert>
        )}

        {status.text && status.level === "err" && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>{status.text}</AlertTitle>
          </Alert>
        )}
      </div>
    </ScrollArea>
  );
}
