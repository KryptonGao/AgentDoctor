import React, { useState } from "react";
import { Box, useInput, useApp, Text } from "ink";
import { ScanResult, Finding } from "../core/types.js";
import { scanRepository } from "../core/scan/scanner.js";
import { applyFix, applySafeFixes } from "../core/fix/fixEngine.js";
import { copyToClipboard } from "../shared/clipboard.js";
import { generateFixPrompt, generateAllFixPrompts } from "../core/prompt/promptGenerator.js";
import { Header } from "./components/Header.js";
import { StatusBar } from "./components/StatusBar.js";
import { PromptPreviewModal } from "./components/PromptPreviewModal.js";
import { OverviewView } from "./views/OverviewView.js";
import { ContextView } from "./views/ContextView.js";
import { RepositoryView } from "./views/RepositoryView.js";
import { VerificationView } from "./views/VerificationView.js";
import { SessionsView } from "./views/SessionsView.js";
import { FixesView } from "./views/FixesView.js";

interface AppProps {
  initialResult: ScanResult;
}

type TabType = "overview" | "context" | "repository" | "verification" | "sessions" | "fixes";

const TAB_ORDER: TabType[] = ["overview", "context", "repository", "verification", "sessions", "fixes"];

function getActiveFinding(
  tab: TabType,
  result: ScanResult,
  selectedIndex: number,
  selectedFixIndex: number
): Finding | undefined {
  if (tab === "overview") {
    const topIssues = result.findings.filter((f) => (f.confidence ?? 0.85) >= 0.8).slice(0, 6);
    return topIssues[selectedIndex] || topIssues[0];
  }
  if (tab === "context") {
    const contextFindings = result.findings.filter((f) => f.category === "context");
    return contextFindings[selectedIndex] || contextFindings[0];
  }
  if (tab === "repository") {
    const repoFindings = result.findings.filter((f) => f.category === "repository");
    return repoFindings[selectedIndex] || repoFindings[0];
  }
  if (tab === "verification") {
    const verifFindings = result.findings.filter((f) => f.category === "verification");
    return verifFindings[selectedIndex] || verifFindings[0];
  }
  if (tab === "fixes") {
    const fix = result.availableFixes[selectedFixIndex];
    if (!fix) return undefined;
    const match = result.findings.find(
      (f) => f.fix?.id === fix.id || f.evidence.some((e) => e.file === fix.file)
    );
    if (match) return match;
    return {
      id: fix.id,
      ruleId: "context/fix-instruction",
      category: "context",
      severity: fix.isSafe ? "medium" : "high",
      confidence: 0.9,
      title: fix.title,
      description: fix.description,
      evidence: [{ file: fix.file }],
      recommendation: `Apply safe fix: ${fix.title}`,
      fix,
    };
  }
  return undefined;
}

export const App: React.FC<AppProps> = ({ initialResult }) => {
  const { exit } = useApp();
  const [result, setResult] = useState<ScanResult>(initialResult);
  const [activeTab, setActiveTab] = useState<TabType>("overview");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedFixIndex, setSelectedFixIndex] = useState(0);
  const [selectedSessionIndex, setSelectedSessionIndex] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | undefined>();
  const [isScanning, setIsScanning] = useState(false);
  const [previewModalFinding, setPreviewModalFinding] = useState<Finding | null>(null);
  const [previewScrollOffset, setPreviewScrollOffset] = useState(0);

  const doRescan = async () => {
    setIsScanning(true);
    setStatusMessage("Rescanning repository...");
    try {
      const fresh = await scanRepository();
      setResult(fresh);
      setStatusMessage(`Rescan complete! Efficiency Score: ${fresh.overallScore}/100`);
    } catch (err: any) {
      setStatusMessage(`Rescan error: ${err.message || String(err)}`);
    } finally {
      setIsScanning(false);
    }
  };

  useInput(async (input, key) => {
    if (key.ctrl && input === "c") {
      exit();
      return;
    }

    // When Prompt Preview Modal is active
    if (previewModalFinding) {
      if (key.escape || input === "q" || key.backspace) {
        setPreviewModalFinding(null);
        setPreviewScrollOffset(0);
        return;
      }

      if (input === "c" || input === "p" || input === "y") {
        const prompt = previewModalFinding.fixPrompt || generateFixPrompt(previewModalFinding);
        const res = await copyToClipboard(prompt);
        if (res.success) {
          setStatusMessage("✓ Fix prompt copied to clipboard");
        } else {
          setStatusMessage(`Failed to access clipboard: ${res.error || "Unknown"}`);
        }
        return;
      }

      if (key.upArrow || input === "k") {
        setPreviewScrollOffset((prev) => Math.max(0, prev - 1));
        return;
      }

      if (key.downArrow || input === "j") {
        setPreviewScrollOffset((prev) => prev + 1);
        return;
      }

      return;
    }

    if (input === "q") {
      exit();
      return;
    }

    // 'p' key: open prompt preview modal for current finding
    if (input === "p") {
      const active = getActiveFinding(activeTab, result, selectedIndex, selectedFixIndex);
      if (active) {
        setPreviewModalFinding(active);
        setPreviewScrollOffset(0);
      } else {
        setStatusMessage("Prompt unavailable for this finding");
      }
      return;
    }

    // 'P' key (Shift+P): Copy all fix prompts
    if (input === "P") {
      const prompt = generateAllFixPrompts(result.findings);
      const res = await copyToClipboard(prompt);
      if (res.success) {
        setStatusMessage("✓ Copied all qualified fix prompts to clipboard");
      } else {
        setStatusMessage(`Failed to access clipboard: ${res.error || "Unknown"}`);
      }
      return;
    }

    // Number keys for tabs
    if (input === "1") { setActiveTab("overview"); setSelectedIndex(0); return; }
    if (input === "2") { setActiveTab("context"); setSelectedIndex(0); return; }
    if (input === "3") { setActiveTab("repository"); setSelectedIndex(0); return; }
    if (input === "4") { setActiveTab("verification"); setSelectedIndex(0); return; }
    if (input === "5") { setActiveTab("sessions"); return; }
    if (input === "6" || input === "f") { setActiveTab("fixes"); return; }

    // Tab key cycling
    if (key.tab) {
      const currIdx = TAB_ORDER.indexOf(activeTab);
      const nextIdx = (currIdx + 1) % TAB_ORDER.length;
      setActiveTab(TAB_ORDER[nextIdx]);
      setSelectedIndex(0);
      return;
    }

    // Rescan key
    if (input === "r") {
      doRescan();
      return;
    }

    // Up / Down navigation
    if (key.upArrow || input === "k") {
      if (activeTab === "fixes") {
        setSelectedFixIndex((prev) => Math.max(0, prev - 1));
      } else if (activeTab === "sessions") {
        setSelectedSessionIndex((prev) => Math.max(0, prev - 1));
      } else {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      }
      return;
    }

    if (key.downArrow || input === "j") {
      if (activeTab === "fixes") {
        setSelectedFixIndex((prev) => Math.min(result.availableFixes.length - 1, prev + 1));
      } else if (activeTab === "sessions") {
        setSelectedSessionIndex((prev) => Math.min(result.sessions.length - 1, prev + 1));
      } else {
        setSelectedIndex((prev) => prev + 1);
      }
      return;
    }

    // Enter key: Apply fix if in fixes tab, or open Prompt Preview if on a finding
    if (key.return) {
      if (activeTab === "fixes" && result.availableFixes.length > 0) {
        const fix = result.availableFixes[selectedFixIndex];
        if (fix) {
          const res = applyFix(fix);
          if (res.success) {
            setStatusMessage(`✓ Applied fix: ${fix.title}`);
            doRescan();
          } else {
            setStatusMessage(`✕ Failed to apply fix: ${res.error}`);
          }
        }
        return;
      }

      // Enter on finding opens Prompt Preview
      const active = getActiveFinding(activeTab, result, selectedIndex, selectedFixIndex);
      if (active) {
        setPreviewModalFinding(active);
        setPreviewScrollOffset(0);
      }
      return;
    }

    // 'a' key: Apply all safe fixes
    if (input === "a" && activeTab === "fixes") {
      const safeFixes = result.availableFixes.filter((f) => f.isSafe);
      if (safeFixes.length > 0) {
        const { applied, failed } = applySafeFixes(safeFixes);
        setStatusMessage(`Applied ${applied.length} safe fixes! (${failed.length} failed)`);
        doRescan();
      } else {
        setStatusMessage("No safe fixes available to apply automatically.");
      }
      return;
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Header
        repositoryName={result.repositoryName}
        branch={result.branch}
        activeTab={activeTab}
      />

      {isScanning ? (
        <Box padding={2} justifyContent="center">
          <Text color="cyan">Scanning repository diagnostics...</Text>
        </Box>
      ) : previewModalFinding ? (
        <PromptPreviewModal
          finding={previewModalFinding}
          scrollOffset={previewScrollOffset}
        />
      ) : (
        <>
          {activeTab === "overview" && (
            <OverviewView result={result} selectedIndex={selectedIndex} />
          )}
          {activeTab === "context" && (
            <ContextView result={result} selectedIndex={selectedIndex} />
          )}
          {activeTab === "repository" && (
            <RepositoryView result={result} selectedIndex={selectedIndex} />
          )}
          {activeTab === "verification" && (
            <VerificationView result={result} selectedIndex={selectedIndex} />
          )}
          {activeTab === "sessions" && (
            <SessionsView
              result={result}
              selectedSessionIndex={selectedSessionIndex}
            />
          )}
          {activeTab === "fixes" && (
            <FixesView
              result={result}
              selectedFixIndex={selectedFixIndex}
            />
          )}
        </>
      )}

      <StatusBar statusMessage={statusMessage} />
    </Box>
  );
};
