import { useState, useCallback, useEffect, useRef } from "react";

const STORAGE_KEY = "bw-tour-seen";

export interface TourStep {
  target: string;
  title: string;
  content: string;
}

const TOUR_STEPS: TourStep[] = [
  {
    target: "[data-tour='activity-bar']",
    title: "Navigation",
    content:
      "Switch between Discovery, API Explorer, and Settings from the sidebar.",
  },
  {
    target: "[data-tour='url-bar']",
    title: "URL Bar",
    content:
      "Navigate to any website you want to explore. Just type a URL and press Enter.",
  },
  {
    target: "[data-tour='discovery-panel']",
    title: "Discovery Panel",
    content:
      "This panel controls your discovery session. Start recording, browse the site, then stop to analyze.",
  },
  {
    target: "[data-tour='start-exploring']",
    title: "Start Exploring",
    content:
      "Click here to begin recording your interactions. Browse the site normally — each page you visit will be captured.",
  },
  {
    target: "[data-tour='execution-mode']",
    title: "API Explorer",
    content:
      "After discovery, switch here to view discovered pages, workflows, and API endpoints.",
  },
  {
    target: "[data-tour='settings-mode']",
    title: "Settings",
    content:
      "Configure your LLM provider and API key to enable AI-powered discovery.",
  },
  {
    target: "[data-tour='status-bar']",
    title: "Status Bar",
    content:
      "Check the server connection status here. A green dot means the API server is running.",
  },
];

const HIGHLIGHT_CLASS = "tour-highlight";

export function useTour() {
  const [run, setRun] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const prevTargetRef = useRef<Element | null>(null);

  // Auto-start on first launch
  useEffect(() => {
    if (!localStorage.getItem(STORAGE_KEY)) {
      const timer = setTimeout(() => setRun(true), 500);
      return () => clearTimeout(timer);
    }
  }, []);

  // Manage highlight class on current target
  useEffect(() => {
    // Remove previous highlight
    if (prevTargetRef.current) {
      prevTargetRef.current.classList.remove(HIGHLIGHT_CLASS);
      prevTargetRef.current = null;
    }

    if (!run) return;

    const step = TOUR_STEPS[stepIndex];
    if (!step) return;

    const el = document.querySelector(step.target);
    if (el) {
      el.classList.add(HIGHLIGHT_CLASS);
      prevTargetRef.current = el;
    }

    return () => {
      if (prevTargetRef.current) {
        prevTargetRef.current.classList.remove(HIGHLIGHT_CLASS);
        prevTargetRef.current = null;
      }
    };
  }, [run, stepIndex]);

  const startTour = useCallback(() => {
    setStepIndex(0);
    setRun(true);
  }, []);

  const next = useCallback(() => {
    if (stepIndex < TOUR_STEPS.length - 1) {
      setStepIndex((i) => i + 1);
    } else {
      setRun(false);
      localStorage.setItem(STORAGE_KEY, "1");
    }
  }, [stepIndex]);

  const back = useCallback(() => {
    if (stepIndex > 0) setStepIndex((i) => i - 1);
  }, [stepIndex]);

  const skip = useCallback(() => {
    setRun(false);
    localStorage.setItem(STORAGE_KEY, "1");
  }, []);

  return {
    steps: TOUR_STEPS,
    run,
    stepIndex,
    currentStep: run ? TOUR_STEPS[stepIndex] : null,
    totalSteps: TOUR_STEPS.length,
    startTour,
    next,
    back,
    skip,
    isFirst: stepIndex === 0,
    isLast: stepIndex === TOUR_STEPS.length - 1,
  };
}
