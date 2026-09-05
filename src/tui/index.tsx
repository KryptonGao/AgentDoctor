import React from "react";
import { render } from "ink";
import { scanRepository } from "../core/scan/scanner.js";
import { App } from "./App.js";

export async function launchTui(options: { sessionPath?: string; cwd?: string } = {}) {
  const initialResult = await scanRepository({
    cwd: options.cwd,
    sessionPath: options.sessionPath,
  });

  const { waitUntilExit } = render(<App initialResult={initialResult} />);
  await waitUntilExit();
}
