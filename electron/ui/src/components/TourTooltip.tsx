import React from "react";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { X } from "lucide-react";

interface TourCardProps {
  title: string;
  content: string;
  stepIndex: number;
  totalSteps: number;
  isFirst: boolean;
  isLast: boolean;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
}

export function TourCard({
  title,
  content,
  stepIndex,
  totalSteps,
  isFirst,
  isLast,
  onNext,
  onBack,
  onSkip,
}: TourCardProps) {
  return (
    <div className="absolute bottom-10 right-4 z-50 w-72 animate-in fade-in slide-in-from-bottom-2 duration-200">
      <Card className="shadow-lg border-primary/20">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">{title}</CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs font-normal">
                {stepIndex + 1} / {totalSteps}
              </Badge>
              <button
                onClick={onSkip}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="text-muted-foreground text-sm">
          {content}
        </CardContent>

        <CardFooter className="flex justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={onSkip}>
            Skip tour
          </Button>

          <div className="flex gap-2">
            {!isFirst && (
              <Button variant="outline" size="sm" onClick={onBack}>
                Back
              </Button>
            )}
            <Button size="sm" onClick={onNext}>
              {isLast ? "Done" : "Next"}
            </Button>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
