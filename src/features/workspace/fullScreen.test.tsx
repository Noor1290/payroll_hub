import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CompanyContext, type CompanyContextValue } from "@/features/company/company-context";
import { WorkspaceHost } from "./WorkspaceHost";

// jsdom has no Fullscreen API: a stand-in that behaves as a browser does, including Esc
// (the browser leaving full screen by itself and firing `fullscreenchange`).
let fullElement: Element | null = null;
const changed = () => document.dispatchEvent(new Event("fullscreenchange"));
const becomeFull = (element: Element | null) => {
  fullElement = element;
  changed();
  return Promise.resolve();
};
const request = vi.fn(function (this: Element) {
  return becomeFull(this);
});
const exit = vi.fn(() => becomeFull(null));
const pressEsc = () => act(() => void exit());

beforeEach(() => {
  fullElement = null;
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => fullElement,
  });
  Element.prototype.requestFullscreen = request as unknown as Element["requestFullscreen"];
  document.exitFullscreen = exit;
  request.mockClear();
  exit.mockClear();
});
afterEach(() => cleanup());

const company: CompanyContextValue = {
  status: "ready",
  failure: null,
  retry: () => {},
  memberships: [],
  current: null,
  isAdmin: true,
  canAddCompany: true,
  select: () => {},
};

function renderHost() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <CompanyContext.Provider value={company}>
          <WorkspaceHost visible />
        </CompanyContext.Provider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const enterButtons = () => screen.getAllByRole("button", { name: /^Show .+ full screen$/ });

describe("the Full screen button of an app", () => {
  it("is there for every app tab, and each one enters and leaves full screen", () => {
    renderHost();
    const names = enterButtons().map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual([
      "Show Payroll System full screen",
      expect.stringMatching(/^Show .+ full screen$/),
      expect.stringMatching(/^Show .+ full screen$/),
      expect.stringMatching(/^Show .+ full screen$/),
    ]);

    for (const name of names) {
      fireEvent.click(screen.getByRole("button", { name: name! }));
      expect(fullElement?.getAttribute("role")).toBe("tabpanel");

      // Pressed again: back to normal size.
      fireEvent.click(screen.getByRole("button", { name: "Leave full screen" }));
      expect(exit).toHaveBeenCalledTimes(1);
      expect(fullElement).toBeNull();
      expect(screen.getByRole("button", { name: name! })).toBeTruthy();
      exit.mockClear();
    }
    expect(request).toHaveBeenCalledTimes(names.length);
  });

  it("follows Esc: the button reads 'Leave full screen' only while the app is full screen", () => {
    renderHost();
    fireEvent.click(enterButtons()[0]!);
    expect(screen.getByRole("button", { name: "Leave full screen" })).toBeTruthy();

    pressEsc();
    expect(screen.queryByRole("button", { name: "Leave full screen" })).toBeNull();
    expect(enterButtons()).toHaveLength(4);

    // And it enters again on the next press (not a leave of a full screen that is gone).
    fireEvent.click(enterButtons()[0]!);
    expect(request).toHaveBeenCalledTimes(2);
    expect(fullElement).not.toBeNull();
  });

  it("ends full screen when a dashboard pop-up opens outside the app, so it can be seen", async () => {
    renderHost();
    fireEvent.click(enterButtons()[0]!);
    expect(fullElement).not.toBeNull();

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    await act(async () => {
      document.body.appendChild(dialog);
      await Promise.resolve();
    });
    expect(exit).toHaveBeenCalledTimes(1);
    expect(fullElement).toBeNull();
    dialog.remove();
  });

  it("stays full screen for something added inside the app's own pane", async () => {
    renderHost();
    fireEvent.click(enterButtons()[0]!);
    const inside = document.createElement("div");
    inside.setAttribute("role", "dialog");
    await act(async () => {
      fullElement!.appendChild(inside);
      await Promise.resolve();
    });
    expect(exit).not.toHaveBeenCalled();
    expect(fullElement).not.toBeNull();
  });
});
