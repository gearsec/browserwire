import React, { useState, useEffect, useCallback, useMemo } from "react";
import { AlertCircle, Check, ChevronDown, ChevronUp, Info } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectGroup, SelectTrigger, SelectContent, SelectItem, SelectValue } from "../../components/ui/select";
import { Alert, AlertTitle, AlertDescription } from "../../components/ui/alert";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { cn } from "../../lib/utils";

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

interface SettingsSnapshot {
  provider: string;
  model: string;
  baseUrl: string;
  port: string;
  hasApiKey: boolean;
  langsmithProject: string;
  hasLangsmithKey: boolean;
  llmConfigured: boolean;
}

function getMissingRequirement(provider: string, hasApiKey: boolean) {
  if (!provider) return "Select an LLM provider to enable discovery.";
  if (provider !== "ollama" && !hasApiKey) return "Add an API key to finish connecting this provider.";
  return "";
}

export function SettingsPanel() {
  const [provider, setProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [port, setPort] = useState("8787");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [langsmithApiKey, setLangsmithApiKey] = useState("");
  const [langsmithProject, setLangsmithProject] = useState("");
  const [hasLangsmithKey, setHasLangsmithKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saveSuccess, setSaveSuccess] = useState("");
  const [providerDefaults, setProviderDefaults] = useState(FALLBACK_DEFAULTS);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [initialSettings, setInitialSettings] = useState<SettingsSnapshot | null>(null);
  const [hasSavedOnce, setHasSavedOnce] = useState(false);

  useEffect(() => {
    let cancelled = false;

    window.browserwire.getSettings().then((settings) => {
      if (cancelled) return;

      const nextProvider = settings.provider || "";
      const nextModel = settings.model || "";
      const nextBaseUrl = settings.baseUrl || "";
      const nextPort = String(settings.port ?? 8787);
      const nextHasApiKey = !!settings.hasApiKey;
      const nextHasLangsmithKey = !!settings.hasLangsmithKey;
      const nextLangsmithProject = settings.langsmithProject || "";

      setProvider(nextProvider);
      setModel(nextModel);
      setBaseUrl(nextBaseUrl);
      setPort(nextPort);
      setHasApiKey(nextHasApiKey);
      setHasLangsmithKey(nextHasLangsmithKey);
      setLangsmithProject(nextLangsmithProject);
      if (settings.providerDefaults) setProviderDefaults(settings.providerDefaults);
      setInitialSettings({
        provider: nextProvider,
        model: nextModel,
        baseUrl: nextBaseUrl,
        port: nextPort,
        hasApiKey: nextHasApiKey,
        langsmithProject: nextLangsmithProject,
        hasLangsmithKey: nextHasLangsmithKey,
        llmConfigured: !!settings.llmConfigured,
      });
      setLoadError("");
    }).catch(() => {
      if (cancelled) return;
      setLoadError("Failed to load settings.");
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!saveSuccess) return undefined;

    const timeout = window.setTimeout(() => setSaveSuccess(""), 2500);
    return () => window.clearTimeout(timeout);
  }, [saveSuccess]);

  const defaults = providerDefaults[provider];
  const effectiveHasApiKey = hasApiKey || !!apiKey;
  const effectiveHasLangsmithKey = hasLangsmithKey || !!langsmithApiKey;
  const missingRequirement = getMissingRequirement(provider, effectiveHasApiKey);
  const llmSectionInvalid = !!missingRequirement;
  const portNumber = Number(port);
  const portInvalid = Number.isNaN(portNumber) || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535;

  const isDirty = useMemo(() => {
    if (!initialSettings) return false;

    return (
      provider !== initialSettings.provider
      || model !== initialSettings.model
      || baseUrl !== initialSettings.baseUrl
      || port !== initialSettings.port
      || langsmithProject !== initialSettings.langsmithProject
      || !!apiKey
      || !!langsmithApiKey
    );
  }, [apiKey, baseUrl, initialSettings, langsmithApiKey, langsmithProject, model, port, provider]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError("");
    setSaveSuccess("");

    try {
      const payload: any = {
        provider: provider || undefined,
        apiKey: apiKey || undefined,
        model: model || undefined,
        baseUrl: baseUrl || undefined,
        port: port ? Number(port) : undefined,
        langsmithApiKey: langsmithApiKey || undefined,
        langsmithProject: langsmithProject || undefined,
      };

      const result = await window.browserwire.saveSettings(payload);

      if (!result.ok) {
        setSaveError(result.error || "Unable to save settings.");
        return;
      }

      const nextHasApiKey = hasApiKey || !!apiKey;
      const nextHasLangsmithKey = hasLangsmithKey || !!langsmithApiKey;

      if (apiKey) {
        setApiKey("");
        setHasApiKey(true);
      }

      if (langsmithApiKey) {
        setLangsmithApiKey("");
        setHasLangsmithKey(true);
      }

      setInitialSettings({
        provider,
        model,
        baseUrl,
        port,
        hasApiKey: nextHasApiKey,
        langsmithProject,
        hasLangsmithKey: nextHasLangsmithKey,
        llmConfigured: !!result.llmConfigured,
      });

      setHasSavedOnce(true);
      setSaveSuccess("Settings saved.");
    } catch (err: any) {
      setSaveError(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }, [apiKey, baseUrl, hasApiKey, hasLangsmithKey, langsmithApiKey, langsmithProject, model, port, provider]);

  return (
    <ScrollArea className="flex-1">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">Settings</h2>
            <p className="text-sm text-muted-foreground">
              Configure your LLM provider, local server, and optional telemetry.
            </p>
          </div>
        </div>

        {loadError ? (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>{loadError}</AlertTitle>
          </Alert>
        ) : null}

        {saveError ? (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Could not save settings</AlertTitle>
            <AlertDescription>{saveError}</AlertDescription>
          </Alert>
        ) : null}

        <Card className={cn(llmSectionInvalid && "border-destructive/60 bg-destructive/5")}>
          <CardHeader>
            <CardTitle className={cn("text-base", llmSectionInvalid && "text-destructive")}>LLM configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {llmSectionInvalid ? (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-background px-3 py-2 text-sm text-destructive">
                <Info className="mt-0.5 size-4 shrink-0" />
                <p>{missingRequirement}</p>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="llm-provider">LLM provider</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger id="llm-provider">
                  <SelectValue placeholder="Select provider" />
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
              {!provider ? (
                <p className="text-xs text-destructive">Required for discovery.</p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="api-key">API key</Label>
              <Input
                id="api-key"
                type="password"
                placeholder={provider === "ollama" ? "Not required for Ollama" : "Enter API key"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              {provider === "ollama" ? (
                <p className="text-xs text-muted-foreground">Ollama connects to your local model and does not need an API key.</p>
              ) : !effectiveHasApiKey ? (
                <p className="text-xs text-destructive">Required for this provider.</p>
              ) : hasApiKey && !apiKey ? (
                <p className="text-xs text-muted-foreground">API key saved securely. Enter a new key only if you want to replace it.</p>
              ) : (
                <p className="text-xs text-muted-foreground">Stored securely in Keychain when available.</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="model">Model</Label>
              <Input
                id="model"
                placeholder={defaults?.model || "Default model"}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Leave blank to use the provider default{defaults?.model ? ` (${defaults.model})` : ""}.
              </p>
            </div>

            <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
              {provider
                ? `Default endpoint: ${defaults?.baseUrl || "Not available"}`
                : "Choose a provider to see its default endpoint and model."}
            </div>

            <button
              type="button"
              className="flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              {advancedOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
              Advanced
            </button>

            {advancedOpen ? (
              <div className="space-y-1.5 rounded-md border border-border p-3">
                <Label htmlFor="base-url">Base URL</Label>
                <Input
                  id="base-url"
                  placeholder={defaults?.baseUrl || "Enter custom endpoint"}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Only change this when using a proxy, gateway, or self-hosted compatible endpoint.</p>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card className={cn(portInvalid && "border-destructive/60 bg-destructive/5")}>
          <CardHeader>
            <CardTitle className={cn("text-base", portInvalid && "text-destructive")}>Server</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            <Label htmlFor="server-port">Server port</Label>
            <Input
              id="server-port"
              type="number"
              min={1}
              max={65535}
              placeholder="8787"
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
            {portInvalid ? (
              <p className="text-xs text-destructive">Enter a valid port from 1 to 65535.</p>
            ) : (
              <p className="text-xs text-muted-foreground">Restart BrowserWire after changing the port.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Telemetry</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="langsmith-api-key">LangSmith API key</Label>
              <Input
                id="langsmith-api-key"
                type="password"
                placeholder="Enter LangSmith API key"
                value={langsmithApiKey}
                onChange={(e) => setLangsmithApiKey(e.target.value)}
              />
              {effectiveHasLangsmithKey && !langsmithApiKey ? (
                <p className="text-xs text-muted-foreground">LangSmith key saved securely. Enter a new key only if you want to replace it.</p>
              ) : (
                <p className="text-xs text-muted-foreground">Optional. Add this only if you want tracing and evaluation telemetry.</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="langsmith-project">LangSmith project</Label>
              <Input
                id="langsmith-project"
                placeholder="browserwire"
                value={langsmithProject}
                onChange={(e) => setLangsmithProject(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">Optional. Leave blank to use the default project.</p>
            </div>
          </CardContent>
        </Card>

        <div className="sticky bottom-0 flex flex-col gap-2 rounded-lg border border-border bg-background/95 p-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-h-5 text-sm text-muted-foreground">
            {saving ? "Saving..." : isDirty ? "You have unsaved changes." : hasSavedOnce && saveSuccess ? (
              <span className="inline-flex items-center gap-2">
                <Check className="size-4 text-primary" />
                <span>{saveSuccess}</span>
              </span>
            ) : null}
          </div>
          <Button disabled={saving || !isDirty || portInvalid} onClick={handleSave}>
            {saving ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </div>
    </ScrollArea>
  );
}
