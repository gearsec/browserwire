import React, { useState, useCallback } from "react";
import { Loader2, Check, AlertCircle, Play } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Alert, AlertTitle, AlertDescription } from "../../components/ui/alert";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../components/ui/table";
import { ScrollArea } from "../../components/ui/scroll-area";
import type { Workflow, WorkflowResult } from "../hooks/useExecution";

interface WorkflowCardProps {
  workflow: Workflow;
  result?: WorkflowResult;
  onExecute: (inputs: Record<string, any>) => void;
}

const KIND_VARIANTS: Record<string, "default" | "secondary" | "outline"> = {
  read: "secondary",
  write: "default",
  mixed: "outline",
};

function humanize(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function ResultTable({ data }: { data: any[] }) {
  if (!data || data.length === 0) return null;
  const keys = Object.keys(data[0]);

  return (
    <ScrollArea className="max-h-64">
      <Table>
        <TableHeader>
          <TableRow>
            {keys.map((k) => (
              <TableHead key={k} className="text-xs">{humanize(k)}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row, i) => (
            <TableRow key={i}>
              {keys.map((k) => (
                <TableCell key={k} className="text-xs truncate max-w-[200px]">
                  {row[k] != null ? String(row[k]) : ""}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}

export function WorkflowCard({ workflow, result, onExecute }: WorkflowCardProps) {
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const loading = result?.loading ?? false;

  const handleRun = useCallback(() => {
    const parsed: Record<string, any> = {};
    for (const input of workflow.inputs || []) {
      const val = inputs[input.name] || "";
      if (input.type === "number") {
        parsed[input.name] = val ? Number(val) : undefined;
      } else if (input.type === "boolean") {
        parsed[input.name] = val === "true";
      } else {
        parsed[input.name] = val || undefined;
      }
    }
    onExecute(parsed);
  }, [inputs, workflow.inputs, onExecute]);

  const hasInputs = workflow.inputs && workflow.inputs.length > 0;
  const hasData = result?.ok && Array.isArray(result.data) && result.data.length > 0;
  const hasError = result && !result.loading && result.ok === false;
  const hasSuccess = result && !result.loading && result.ok === true;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">{humanize(workflow.name)}</CardTitle>
          <Badge variant={KIND_VARIANTS[workflow.kind] || "outline"} className="text-[10px]">
            {workflow.kind}
          </Badge>
        </div>
        {workflow.description && (
          <p className="text-xs text-muted-foreground">{workflow.description}</p>
        )}
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          {hasInputs && (
            <div className="flex flex-col gap-2">
              {workflow.inputs.map((inp) => (
                <div key={inp.name} className="flex flex-col gap-1.5">
                  <Label htmlFor={`wf-${workflow.name}-${inp.name}`} className="text-xs text-muted-foreground">
                    {humanize(inp.name)}
                    {inp.required && <span className="text-destructive"> *</span>}
                  </Label>
                  <Input
                    id={`wf-${workflow.name}-${inp.name}`}
                    placeholder={inp.description || `Enter ${humanize(inp.name).toLowerCase()}…`}
                    type={inp.type === "number" ? "number" : "text"}
                    value={inputs[inp.name] || ""}
                    onChange={(e) =>
                      setInputs((prev) => ({ ...prev, [inp.name]: e.target.value }))
                    }
                  />
                </div>
              ))}
            </div>
          )}

          <Button className="w-full" disabled={loading} onClick={handleRun}>
            {loading ? (
              <>
                <Loader2 className="animate-spin" />
                Running…
              </>
            ) : (
              <>
                <Play />
                Run
              </>
            )}
          </Button>

          {hasSuccess && hasData && (
            <div className="flex flex-col gap-2">
              <Alert variant="success">
                <Check className="size-4" />
                <AlertTitle>
                  {result.data.length} {result.data.length === 1 ? "result" : "results"}
                </AlertTitle>
              </Alert>
              <ResultTable data={result.data} />
            </div>
          )}

          {hasSuccess && !hasData && (
            <Alert variant="success">
              <Check className="size-4" />
              <AlertTitle>
                {result.outcome === "success" ? "Action completed successfully" : "Completed"}
              </AlertTitle>
            </Alert>
          )}

          {hasError && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Workflow failed</AlertTitle>
              <AlertDescription>{result.error || result.message}</AlertDescription>
            </Alert>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
