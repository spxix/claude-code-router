import { spawn, type StdioOptions } from "child_process";
import * as fs from "fs";
import {getSettingsPath, readConfigFile} from ".";
import {
  decrementReferenceCount,
  incrementReferenceCount,
  closeService,
} from "./processCheck";
import { quote } from 'shell-quote';
import minimist from "minimist";
import { createEnvVariables } from "./createEnvVariables";

export interface PresetConfig {
  noServer?: boolean;
  claudeCodeSettings?: {
    env?: Record<string, any>;
    statusLine?: any;
    [key: string]: any;
  };
  provider?: string;
  router?: Record<string, any>;
  StatusLine?: any;  // Preset's StatusLine configuration
  [key: string]: any;
}

export async function executeCodeCommand(
  args: string[] = [],
  presetConfig?: PresetConfig | null,
  envOverrides?: Record<string, string>,
  presetName?: string  // Preset name for statusline command
) {
  // Set environment variables using shared function
  const config = await readConfigFile();
  const env = await createEnvVariables();

  // Apply environment variable overrides (from preset's provider configuration)
  if (envOverrides) {
    Object.assign(env, envOverrides);
  }

  // Build settingsFlag
  let settingsFlag: ClaudeSettingsFlag = {
    env: env as ClaudeSettingsFlag['env']
  };

  // Add statusLine configuration
  // Priority: preset.StatusLine > global config.StatusLine
  const statusLineConfig = presetConfig?.StatusLine || config?.StatusLine;

  if (statusLineConfig?.enabled) {
    // If using preset, pass preset name to statusline command
    const statuslineCommand = presetName
      ? `ccr statusline ${presetName}`
      : "ccr statusline";

    settingsFlag.statusLine = {
      type: "command",
      command: statuslineCommand,
      padding: 0,
    }
  }

  // Merge claudeCodeSettings from preset into settingsFlag
  if (presetConfig?.claudeCodeSettings) {
    settingsFlag = {
      ...settingsFlag,
      ...presetConfig.claudeCodeSettings,
      // Deep merge env
      env: {
        ...settingsFlag.env,
        ...presetConfig.claudeCodeSettings.env,
      } as ClaudeSettingsFlag['env']
    };
  }

  // Non-interactive mode for automation environments
  if (config.NON_INTERACTIVE_MODE) {
    settingsFlag.env = {
      ...settingsFlag.env,
      CI: "true",
      FORCE_COLOR: "0",
      NODE_NO_READLINE: "1",
      TERM: "dumb"
    }
  }

  const settingsFile = await getSettingsPath(`${JSON.stringify(settingsFlag)}`)

  args.push('--settings', settingsFile);

  // Increment reference count when command starts
  incrementReferenceCount();

  // Execute claude command
  const claudePath = config?.CLAUDE_PATH || process.env.CLAUDE_PATH || "claude";

  const joinedArgs = args.length > 0 ? quote(args) : "";

  const stdioConfig: StdioOptions = config.NON_INTERACTIVE_MODE
    ? ["pipe", "pipe", "inherit"] // Pipe stdin and stdout for non-interactive SDK mode
    : "inherit"; // Default inherited behavior

  const argsObj = minimist(args)
  const argsArr: string[] = []
  for (const [argsObjKey, argsObjValue] of Object.entries(argsObj)) {
    // Skip the '_' key (positional arguments) and undefined values only
    // Allow falsy values like empty strings, 0, false
    if (argsObjKey !== '_' && argsObjValue !== undefined) {
      const prefix = argsObjKey.length === 1 ? '-' : '--';
      // For boolean flags, don't append the value
      if (argsObjValue === true) {
        argsArr.push(`${prefix}${argsObjKey}`);
      } else if (argsObjValue === false) {
        // Skip false boolean flags
        continue;
      } else {
        // In NON_INTERACTIVE_MODE, use shell: false which requires separate flag and value
        // In interactive mode, keep combined for shell: true compatibility
        if (config.NON_INTERACTIVE_MODE) {
          argsArr.push(`${prefix}${argsObjKey}`);
          // Convert value to string (JSON.stringify adds quotes, we just need the raw value)
          argsArr.push(typeof argsObjValue === 'string' ? argsObjValue : JSON.stringify(argsObjValue));
        } else {
          argsArr.push(`${prefix}${argsObjKey} ${JSON.stringify(argsObjValue)}`);
        }
      }
    }
  }
  const claudeProcess = spawn(
    claudePath,
    argsArr,
    {
      env: {
        ...process.env,
      },
      stdio: stdioConfig,
      // Use shell: false in NON_INTERACTIVE_MODE for proper stdin forwarding
      // Shell mode intercepts stdin which breaks SDK control protocol
      shell: !config.NON_INTERACTIVE_MODE,
    }
  );

  // In non-interactive mode, forward stdin from parent process to claude subprocess
  // This is necessary for SDK control protocol (initialize, interrupt, etc.) to work
  if (config.NON_INTERACTIVE_MODE && claudeProcess.stdin) {
    process.stdin.pipe(claudeProcess.stdin);
    process.stdin.on('end', () => {
      claudeProcess.stdin?.end();
    });
  }

  // In non-interactive mode, forward stdout from claude subprocess
  // Check CCR_OUTPUT_FILE for file-based output (bypasses stdout pipe issues with tee)
  if (config.NON_INTERACTIVE_MODE && claudeProcess.stdout) {
    const outputFilePath = process.env.CCR_OUTPUT_FILE;
    if (outputFilePath) {
      // File-based output mode: write to file instead of stdout
      // This bypasses issues with stdout pipe when running under tee wrappers
      const outputFd = fs.openSync(outputFilePath, 'a');
      claudeProcess.stdout.on('data', (chunk: Buffer) => {
        fs.writeSync(outputFd, chunk);
        fs.fsyncSync(outputFd); // Force flush to disk immediately
      });
      claudeProcess.on('close', () => {
        fs.closeSync(outputFd);
      });
    } else {
      // Default: pipe to stdout
      claudeProcess.stdout.pipe(process.stdout);
    }
  }

  claudeProcess.on("error", (error) => {
    console.error("Failed to start claude command:", error.message);
    console.log(
      "Make sure Claude Code is installed: npm install -g @anthropic-ai/claude-code"
    );
    decrementReferenceCount();
    process.exit(1);
  });

  claudeProcess.on("close", (code) => {
    decrementReferenceCount();
    closeService();
    process.exit(code || 0);
  });
}
