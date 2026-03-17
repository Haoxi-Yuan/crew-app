import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";

export class CrewWebViewPanel {
  private static instance: CrewWebViewPanel | undefined;
  private panel: vscode.WebviewPanel;
  private extensionUri: vscode.Uri;
  private _port: number;
  private _target: { view?: "chat" | "dashboard"; channelId?: string; projectId?: string; peakId?: string } | null;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    port: number,
    target?: { view?: "chat" | "dashboard"; channelId?: string; projectId?: string; peakId?: string },
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this._port = port;
    this._target = target || null;

    this.panel.onDidDispose(() => {
      CrewWebViewPanel.instance = undefined;
    });

    this.update();
  }

  static createOrShow(
    extensionUri: vscode.Uri,
    port: number,
    target?: { view?: "chat" | "dashboard"; channelId?: string; projectId?: string; peakId?: string },
  ): CrewWebViewPanel {
    if (CrewWebViewPanel.instance) {
      CrewWebViewPanel.instance._port = port;
      CrewWebViewPanel.instance._target = target || null;
      CrewWebViewPanel.instance.update();
      CrewWebViewPanel.instance.panel.reveal();
      return CrewWebViewPanel.instance;
    }

    const panel = vscode.window.createWebviewPanel(
      "claudeCrewPanel",
      "Claude Crew",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "media"),
        ],
      },
    );

    CrewWebViewPanel.instance = new CrewWebViewPanel(panel, extensionUri, port, target);
    return CrewWebViewPanel.instance;
  }

  updatePort(port: number): void {
    this._port = port;
    this.update();
  }

  /** Notify the WebView that the server state changed. */
  static notifyServerState(state: "running" | "stopped"): void {
    if (CrewWebViewPanel.instance) {
      CrewWebViewPanel.instance.panel.webview.postMessage({ type: "server-state", state });
    }
  }

  private update(): void {
    this.panel.webview.html = this.getHtmlContent();
  }

  private getHtmlContent(): string {
    const webview = this.panel.webview;
    const mediaPath = vscode.Uri.joinPath(this.extensionUri, "media", "web-ui");

    // Try to read the original index.html
    const indexPath = path.join(mediaPath.fsPath, "index.html");
    if (!fs.existsSync(indexPath)) {
      return this.getFallbackHtml();
    }

    let html = fs.readFileSync(indexPath, "utf-8");

    // Replace asset references with WebView-safe URIs
    const stylesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaPath, "styles.css"),
    );
    const bundleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(mediaPath, "dist", "bundle.js"),
    );

    html = html.replace(/href="\/styles\.css"/, `href="${stylesUri}"`);
    html = html.replace(/src="\/dist\/bundle\.js"/, `src="${bundleUri}"`);

    // Inject bridge script before the bundle script
    const bridgeScript = this.getBridgeScript();
    html = html.replace(
      /<script\s+src="[^"]*bundle\.js"><\/script>/,
      `<script>${bridgeScript}</script>\n<script src="${bundleUri}"></script>`,
    );

    // Inject CSP meta tag
    const csp = this.getCSP(webview);
    html = html.replace(
      /<head>/,
      `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    );

    return html;
  }

  private getBridgeScript(): string {
    // Set base URLs for the transport layer (packages/web-ui/src/transport.ts).
    // Apply VS Code theme class to body for CSS variable overrides.
    const serializedTarget = JSON.stringify(this._target || {});
    return `
      (function() {
        window.__CREW_BASE_URL = "http://127.0.0.1:${this._port}";
        window.__CREW_WS_URL = "ws://127.0.0.1:${this._port}/ws";

        try {
          var vscodeApi = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
          if (vscodeApi) {
            var existingState = vscodeApi.getState() || {};
            var nextTarget = ${serializedTarget};
            var nextState = Object.assign({}, existingState);
            if (nextTarget.view) nextState.view = nextTarget.view;
            if (nextTarget.channelId) nextState.channelId = nextTarget.channelId;
            if (nextTarget.projectId) nextState.projectId = nextTarget.projectId;
            vscodeApi.setState(nextState);
          }
        } catch (err) {
          console.warn("Failed to seed Claude Crew webview state", err);
        }

        // Apply VS Code theme class to body.
        // VS Code sets data-vscode-theme-kind on body (vscode-dark, vscode-light, etc.)
        var themeKind = document.body.getAttribute('data-vscode-theme-kind');
        if (themeKind) document.body.classList.add(themeKind);
        // Watch for live theme changes
        new MutationObserver(function(mutations) {
          mutations.forEach(function(m) {
            if (m.attributeName === 'data-vscode-theme-kind') {
              document.body.classList.remove('vscode-dark', 'vscode-light', 'vscode-high-contrast', 'vscode-high-contrast-light');
              var kind = document.body.getAttribute('data-vscode-theme-kind');
              if (kind) document.body.classList.add(kind);
            }
          });
        }).observe(document.body, { attributes: true, attributeFilter: ['data-vscode-theme-kind'] });
      })();
    `;
  }

  private getCSP(webview: vscode.Webview): string {
    return [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data: http://127.0.0.1:*`,
      `font-src ${webview.cspSource}`,
      `connect-src http://127.0.0.1:* ws://127.0.0.1:*`,
    ].join("; ");
  }

  private getFallbackHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
           display: flex; justify-content: center; align-items: center; height: 100vh; }
    .msg { text-align: center; }
    .msg h2 { margin-bottom: 8px; }
    .msg p { opacity: 0.7; }
  </style>
</head>
<body>
  <div class="msg">
    <h2>Claude Crew</h2>
    <p>Web UI assets not found. Run "pnpm build" in the web-ui package first,
    then copy index.html, styles.css, and dist/ to the extension media/web-ui/ folder.</p>
  </div>
</body>
</html>`;
  }
}
