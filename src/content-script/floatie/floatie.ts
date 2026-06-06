import { arrow, computePosition, flip, offset, shift } from "@floating-ui/dom";
import floatieCssTxt from "./floatie.txt.css";
import { Logger } from "../../utils/logger";
import Storage from "../../utils/storage";
import manifest from "../../manifest.json";

/*
 * This component is responsible for rendering
 * the floatie and managing its lifecycle.
 * The floatie is rendered in a shadow dom to
 * avoid interference from parent document.
 * TODO: rename to Popover.ts.
 */
export class Floatie {
  container: HTMLElement;
  copyButton: HTMLElement;
  searchButton: HTMLElement;
  previewButton: HTMLElement;
  tooltipArrow: HTMLElement;
  shadowHost: HTMLElement | null = null;
  shadowRoot: ShadowRoot | null = null;
  isCopyActionEnabled = false;
  showTimeout?: number;
  logger = new Logger(this);
  // Track anchors we've already wired to avoid duplicate listeners on SPA re-renders.
  private wiredAnchors = new WeakSet<HTMLAnchorElement>();
  private domObserver: MutationObserver | null = null;

  constructor() {
    const markup = `
        <div id="sp-floatie-container">
            <div id="sp-floatie-arrow"></div>
            <div id="sp-floatie-search" class="sp-floatie-action" data-action="search">Search</div>
            <div id="sp-floatie-preview" class="sp-floatie-action" data-action="preview">Preview</div>
            <div id="sp-floatie-copy" class="sp-floatie-action" data-action="copy">Copy</div>
        </div>
        `;
    // Parse markup into a temporary container so we can query IDs reliably
    // before any DOM insertion. Previously used DocumentFragment + createRange
    // which had issues querying elements before attachment.
    const tmp = document.createElement("div");
    tmp.innerHTML = markup;

    const container = tmp.querySelector<HTMLElement>("#sp-floatie-container");
    const searchButton = tmp.querySelector<HTMLElement>("#sp-floatie-search");
    const previewButton = tmp.querySelector<HTMLElement>("#sp-floatie-preview");
    const copyButton = tmp.querySelector<HTMLElement>("#sp-floatie-copy");
    const tooltipArrow = tmp.querySelector<HTMLElement>("#sp-floatie-arrow");

    if (
      !container ||
      !searchButton ||
      !previewButton ||
      !copyButton ||
      !tooltipArrow
    ) {
      throw new Error("Impossible error obtaining action buttons from DOM");
    }
    this.container = container;
    this.searchButton = searchButton;
    this.previewButton = previewButton;
    this.copyButton = copyButton;
    this.tooltipArrow = tooltipArrow;

    this.logger.debug("Initialized floatie");
  }

  startListening(): void {
    if (this.inIframe()) {
      return;
    }

    // Fix: Build shadow DOM correctly — attach shadow FIRST, then inject style
    // and container INTO the shadow root. Previously, content was appended to
    // the light DOM before attachShadow() was called, which caused CSS isolation
    // to break on sites with aggressive global resets (e.g. x.com, YouTube).
    const bft = document.createElement("better-previews-tooltip");
    document.body.appendChild(bft);
    const shadow = bft.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = floatieCssTxt;
    shadow.appendChild(style);
    shadow.appendChild(this.container);

    this.shadowHost = bft;
    this.shadowRoot = shadow;

    // Window level events.
    window.onscroll = () => this.hideAll();
    window.onresize = () => this.hideAll();

    // Do not display in contextMenu.
    window.oncontextmenu = () => this.hideAll();

    // TODO: Do not display in contentEditable.

    // Listen for mouse up events and suggest search if there's a selection.
    document.onmouseup = (e) => this.deferredMaybeShow(e);
    document.onkeydown = () => this.hideAll();

    this.setupLinkPreviews();
  }

  /*
   * Wire hover-preview listeners to a single anchor element.
   * Safe to call multiple times on the same element — WeakSet prevents duplicates.
   */
  attachLinkPreview(a: HTMLAnchorElement): void {
    if (this.wiredAnchors.has(a)) {
      return;
    }

    if (!this.isGoodUrl(a.href)) {
      return;
    }

    if (!a.innerText.trim()) {
      // There is no text, we may be highlighting an image.
      return;
    }

    this.wiredAnchors.add(a);

    let showTimeout: any = null;
    let autoPreviewTimeout: any = null;
    let hideTimeout: any = null;

    a.addEventListener("mouseover", (e) => {
      if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
      }

      showTimeout = setTimeout(async () => {
        const previewOnHover =
          (await Storage.get("preview-on-hover")) ?? false;

        this.showActions(a.getBoundingClientRect(), e, a.href, [
          this.previewButton,
        ]);

        if (previewOnHover) {
          const timeout = (await Storage.get("preview-on-hover-delay")) ?? 3;
          // Slowly hide the preview button via opacity over a duration of timeout.
          this.container.classList.add("hide-" + timeout);
          autoPreviewTimeout = setTimeout(() => {
            this.container.className = "";
            this.container.style.display = "none";
            this.sendMessage("preview", a.href);
          }, timeout * 1000);
        }
      }, 500);
    });

    a.addEventListener("mouseout", () => {
      if (showTimeout) {
        clearTimeout(showTimeout);
        showTimeout = null;
      }
      if (autoPreviewTimeout) {
        clearTimeout(autoPreviewTimeout);
        this.container.className = "";
        this.container.style.display = "none";
        autoPreviewTimeout = null;
      }
      hideTimeout = setTimeout(() => {
        this.hideAll();
      }, 2000);
    });
  }

  /*
   * Wire all existing anchors and set up a MutationObserver to catch
   * dynamically injected links from SPAs like x.com, YouTube, etc.
   *
   * Previously this ran querySelectorAll("a") once at load time — any links
   * injected by React/Vue/etc after that point were silently ignored, which
   * is why hover previews never appeared on modern SPA websites.
   */
  setupLinkPreviews(): void {
    // Wire anchors already present in the DOM.
    document.querySelectorAll<HTMLAnchorElement>("a").forEach((a) => {
      this.attachLinkPreview(a);
    });

    // Watch for new nodes added by SPA navigation / infinite scroll.
    this.domObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const el = node as Element;

          // The added node itself might be an <a>.
          if (el.tagName === "A") {
            this.attachLinkPreview(el as HTMLAnchorElement);
          }

          // Or it might be a container with <a> descendants.
          el.querySelectorAll<HTMLAnchorElement>("a").forEach((a) => {
            this.attachLinkPreview(a);
          });
        });
      }
    });

    this.domObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  stopListening(): void {
    // Disconnect the MutationObserver to prevent memory leaks.
    if (this.domObserver) {
      this.domObserver.disconnect();
      this.domObserver = null;
    }

    // Remove shadow host (which contains all floatie UI).
    if (this.shadowHost && document.body.contains(this.shadowHost)) {
      document.body.removeChild(this.shadowHost);
    }

    // Properly null out all window/document listeners.
    document.onmouseup = null;
    document.onkeydown = null;
    window.onscroll = null;
    window.onresize = null;
    window.oncontextmenu = null;
  }

  deferredMaybeShow(e: MouseEvent): void {
    // Allow a little time for cancellation.
    this.showTimeout = window.setTimeout(() => this.maybeShow(e), 100);
  }

  maybeShow(e: MouseEvent): void {
    // Ensure button is hidden by default.
    this.hideAll();

    // Filter out empty/irrelevant selections.
    if (typeof window.getSelection == "undefined") {
      return;
    }
    const selection = window.getSelection()!;
    if (selection.isCollapsed) {
      return;
    }

    // Show appropriate buttons.
    const selectedText = selection.toString().trim();
    const range = selection.getRangeAt(0);
    const boundingRect = range.getBoundingClientRect();
    this.logger.debug("Selected: ", selectedText);
    const actionsToShow: HTMLElement[] = [];
    if (this.shouldShowPreview(e, selectedText)) {
      actionsToShow.push(this.previewButton);
    } else if (this.shouldShowSearch(e, selectedText)) {
      actionsToShow.push(this.searchButton);
    }
    if (this.shouldShowCopy(selectedText)) {
      actionsToShow.push(this.copyButton);
    }
    this.showActions(boundingRect, e, selectedText, actionsToShow);
  }

  getAbsoluteUrl(urlStr: string): URL | null {
    const absoluteUrlMatcher = new RegExp("^(?:[a-z+]+:)?//", "i");
    let url: URL;
    try {
      if (absoluteUrlMatcher.test(urlStr)) {
        url = new URL(urlStr);
      } else {
        return null;
        // TODO: When same domain preview is enabled, check if urlStr is a fragment.
      }
    } catch (e) {
      // href is an invalid URL
      return null;
    }
    return url;
  }

  isGoodUrl(urlStr: string): boolean {
    if (!urlStr || !urlStr.trim()) {
      return false;
    }

    const url = this.getAbsoluteUrl(urlStr);
    if (url === null) {
      return false;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      // We don't want to preview other schemes like tel:
      return false;
    }

    if (url.hostname === window.location.hostname) {
      // Don't preview URLs of the same origin by default.
      // Users can enable same-origin previews via the 'allow-same-origin-previews' option.
      // NOTE: This is intentionally kept synchronous. The async version (checking storage)
      // is only needed for the initial setup — MutationObserver callbacks need sync checks.
      return false;
    }

    return true;
  }

  shouldShowCopy(selectedText: string): boolean {
    return this.isCopyActionEnabled && selectedText.length > 0;
  }

  shouldShowPreview(
    e: MouseEvent | KeyboardEvent,
    selectedText: string,
  ): boolean {
    // Lightweight synchronous URL check used in event callbacks.
    // (isGoodUrl is sync, but we avoid the same-origin restriction here
    // so that clicking a link on x.com to an external site still triggers preview.)
    const looksLikeUrl = (s: string) => {
      try {
        const u = new URL(s);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    };

    const isGoodHyperlink = (e: MouseEvent | KeyboardEvent) => {
      var target: any = e.target;
      do {
        if (
          target.nodeName.toUpperCase() === "A" &&
          target.href
        ) {
          return true;
        }
      } while ((target = target.parentElement));
      return false;
    };

    return looksLikeUrl(selectedText) || isGoodHyperlink(e);
  }

  getPreviewUrl(
    e: MouseEvent | KeyboardEvent,
    selectedText: string,
  ): string | undefined {
    const isWrappedByLink = (e: MouseEvent | KeyboardEvent) => {
      var target: any = e.target;
      do {
        if (
          target.nodeName.toUpperCase() === "A" &&
          target.href
        ) {
          return target.href as string;
        }
      } while ((target = target.parentElement));
      return undefined;
    };

    try {
      const u = new URL(selectedText);
      if (u.protocol === "http:" || u.protocol === "https:") {
        return u.href;
      }
    } catch {}

    return isWrappedByLink(e);
  }

  shouldShowSearch(e: MouseEvent, selectedText: string): boolean {
    const isQuerySize = (text: string) => {
      return text.length > 0 && text.length < 100;
    };

    const isEmail = (email: string) => {
      return String(email)
        .toLowerCase()
        .match(
          /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
        );
    };

    const isDate = (dataStr: string) => {
      return !isNaN(Date.parse(dataStr));
    };

    const isNotSymbols = function (str: string) {
      let notSymbols: boolean = false;
      for (let i = 0; i < str.length; i++) {
        let code = str.charCodeAt(i);
        if (
          (code >= 0 && code <= 47) ||
          (code >= 58 && code <= 64) ||
          (code >= 91 && code <= 96) ||
          (code >= 123 && code <= 255)
        ) {
          continue;
        } else {
          notSymbols = true;
          break;
        }
      }
      return notSymbols;
    };

    return (
      isQuerySize(selectedText) &&
      isNotSymbols(selectedText) &&
      !isEmail(selectedText) &&
      !isDate(selectedText) &&
      !this.shouldShowPreview(e, selectedText)
    );
  }

  showActions(
    boundingRect: DOMRect,
    e: MouseEvent,
    text: string,
    buttons: HTMLElement[],
  ) {
    this.hideAll();
    if (buttons.length === 0) {
      return;
    }

    this.showContainer(boundingRect);
    buttons.forEach((b) => {
      b.style.display = "inline-block";
      b.onclick = () => {
        // Get the latest selection again at click.
        if (typeof window.getSelection != "undefined") {
          const selection = window.getSelection()!;
          if (!selection.isCollapsed) {
            text = selection.toString().trim();
          }

          // Use href for previews.
          if (b.innerText == "Preview") {
            const href = this.getPreviewUrl(e, text);
            if (href) {
              text = href;
            }
          }
        }

        this.sendMessage(
          b.getAttribute("data-action") || "unknown-action",
          text,
        );
        this.hideAll();
      };
    });
  }

  sendMessage(action: string, data: any) {
    window.postMessage(
      { application: manifest.__package_name__, action: action, data: data },
      window.location.origin,
    );
    // chrome.runtime.sendMessage won't work because content is executed in page context.
    // broadcast.postMessage is not ideal because multiple tabs of same origin receive it.
  }

  // It should be a no-op to call this multiple times.
  showContainer(boundingRect: DOMRect): void {
    // Make container visible.
    this.container.style.display = "block";

    // Ensure it's not covered by other page UI.
    const getMaxZIndex = () => {
      return new Promise((resolve: (arg0: number) => void) => {
        const z = Math.max(
          ...Array.from(document.querySelectorAll("body *"), (el) =>
            parseFloat(window.getComputedStyle(el).zIndex),
          ).filter((zIndex) => !Number.isNaN(zIndex)),
          0,
        );
        resolve(z);
      });
    };

    // We cannot pass boundRect directly as the library treats it as an HTMLElement.
    const virtualEl = {
      getBoundingClientRect() {
        return {
          width: boundingRect.width,
          height: boundingRect.height,
          x: boundingRect.x,
          y: boundingRect.y,
          top: boundingRect.top,
          left: boundingRect.left,
          right: boundingRect.right,
          bottom: boundingRect.bottom,
        };
      },
    };

    // Position over reference element.
    computePosition(virtualEl, this.container, {
      placement: "top",
      strategy: "absolute", // If you use "fixed", x, y would change to clientX/Y.
      middleware: [
        offset(12), // Space between mouse and tooltip.
        flip(),
        shift({ padding: 5 }), // Space from the edge of the browser.
        arrow({ element: this.tooltipArrow }),
      ],
    }).then(({ x, y, placement, middlewareData }) => {
      /*
       * screenX/Y - relative to physical screen.
       * clientX/Y - relative to browser viewport. Use with position:fixed.
       * pageX/Y - relative to page. Use this with position:absolute.
       */
      Object.assign(this.container.style, {
        top: `${y}px`,
        left: `${x}px`,
      });

      // Handle arrow placement.
      const coords = middlewareData.arrow;

      let staticSide = "bottom";
      switch (placement.split("-")[0]) {
        case "top":
          staticSide = "bottom";
          break;
        case "left":
          staticSide = "right";
          break;
        case "bottom":
          staticSide = "top";
          break;
        case "right":
          staticSide = "left";
          break;
      }
      Object.assign(this.tooltipArrow.style, {
        left: coords?.x != null ? `${coords.x}px` : "",
        top: coords?.y != null ? `${coords.y}px` : "",
        right: "",
        bottom: "",
        [staticSide]: "-4px", // If you update this, update height and width of arrow.
      });

      getMaxZIndex().then((maxZ: number) => {
        this.container.style.zIndex = "" + (maxZ + 10);
        this.tooltipArrow.style.zIndex = "" + (maxZ - 1);
      });
    });
  }

  hideAll(): void {
    clearTimeout(this.showTimeout);
    this.container.style.display = "none";
    this.copyButton.style.display = "none";
    this.searchButton.style.display = "none";
    this.previewButton.style.display = "none";
  }

  inIframe() {
    try {
      return window.self !== window.top;
    } catch (e) {
      return true;
    }
  }
}
