import React from "react";
import { createRoot } from "react-dom/client";
import { ShellApp } from "./shell/ShellApp";

const root = createRoot(document.getElementById("root")!);
root.render(<ShellApp />);
