(() => {
  "use strict";
  const root = document.documentElement;

  /* Mobile menu */
  const toggle = document.querySelector(".nav-toggle");
  const menu = document.getElementById("mobile-menu");
  const behind = [document.getElementById("main"), document.querySelector(".site-footer")].filter(Boolean);
  const isOpen = () => toggle && toggle.getAttribute("aria-expanded") === "true";

  function setMenu(open, { restoreFocus = false } = {}) {
    if (!toggle || !menu) return;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "メニューを閉じる" : "メニューを開く");
    menu.dataset.open = String(open);
    menu.inert = !open;
    for (const el of behind) el.inert = open;
    root.classList.toggle("menu-open", open);
    if (open) {
      const first = menu.querySelector("a");
      if (first) first.focus({ preventScroll: true });
    } else if (restoreFocus) {
      toggle.focus();
    }
  }

  if (toggle && menu) {
    toggle.addEventListener("click", () => setMenu(!isOpen()));
    menu.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("a")) setMenu(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && isOpen()) setMenu(false, { restoreFocus: true });
    });
    matchMedia("(min-width: 768px)").addEventListener("change", (event) => {
      if (event.matches && isOpen()) setMenu(false);
    });
  }

  if (!("IntersectionObserver" in window)) {
    document.querySelectorAll(".reveal").forEach((el) => el.classList.add("is-visible"));
    document.querySelectorAll(".tagline-text .w").forEach((el) => el.classList.add("is-on"));
    return;
  }

  /* Section reveal: once per section */
  const revealer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add("is-visible");
      revealer.unobserve(entry.target);
    }
  }, { rootMargin: "0px 0px -10% 0px", threshold: 0.08 });
  document.querySelectorAll(".reveal").forEach((el) => revealer.observe(el));

  /* Tagline: each phrase lights up as it crosses a line at 65% of the viewport */
  const words = Array.from(document.querySelectorAll(".tagline-text .w"));
  const order = new Map(words.map((el, index) => [el, index]));
  const lighter = new IntersectionObserver((entries) => {
    const crossed = entries
      .filter((entry) => entry.isIntersecting)
      .map((entry) => entry.target)
      .sort((a, b) => order.get(a) - order.get(b));
    crossed.forEach((el, index) => {
      el.style.transitionDelay = index * 90 + "ms";
      el.classList.add("is-on");
      lighter.unobserve(el);
    });
  }, { rootMargin: "0px 0px -35% 0px", threshold: 1 });
  words.forEach((el) => lighter.observe(el));

  /* Current section in the navigation */
  const spyLinks = Array.from(document.querySelectorAll("[data-spy]"));
  const spy = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const target = entry.target.getAttribute("data-spy-target");
      for (const link of spyLinks) {
        if (target && link.getAttribute("href") === "#" + target) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      }
    }
  }, { rootMargin: "-45% 0px -54% 0px" });
  document.querySelectorAll("[data-spy-target]").forEach((el) => spy.observe(el));
})();

/* Copy buttons */
(() => {
  "use strict";
  for (const button of document.querySelectorAll("[data-copy]")) {
    const label = button.querySelector(".copy-label");
    const status = document.getElementById(button.getAttribute("data-status") || "");
    let timer = 0;
    button.addEventListener("click", async () => {
      const text = button.getAttribute("data-copy") || "";
      try {
        if (!navigator.clipboard) throw new Error("clipboard unavailable");
        await navigator.clipboard.writeText(text);
        button.classList.add("is-done");
        if (label) label.textContent = "コピーしました";
        if (status) {
          status.classList.remove("is-error");
          status.textContent = "クローンのコマンドをクリップボードにコピーしました。";
        }
        clearTimeout(timer);
        timer = setTimeout(() => {
          button.classList.remove("is-done");
          if (label) label.textContent = "コピー";
          if (status) status.textContent = "";
        }, 2400);
      } catch {
        if (status) {
          status.classList.add("is-error");
          status.textContent = "コピーできませんでした。コマンドを選択して、手動でコピーしてください。";
        }
      }
    });
  }
})();
