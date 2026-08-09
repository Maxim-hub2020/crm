const header = document.querySelector("[data-header]");
const menuToggle = document.querySelector("[data-menu-toggle]");
const mobileMenu = document.querySelector("[data-mobile-menu]");
const form = document.querySelector("[data-contact-form]");
const formStatus = document.querySelector("[data-form-status]");
const serviceSelect = document.querySelector("[data-service-select]");
const submitButton = document.querySelector("[data-submit-button]");
const phoneInput = form?.querySelector('input[name="phone"]');
const year = document.querySelector("[data-year]");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let flowFrame = 0;

const syncHeader = () => {
  header?.classList.toggle("is-scrolled", window.scrollY > 24);
};

const syncFlowMotion = () => {
  flowFrame = 0;
  const progress = reducedMotion.matches ? 0 : Math.min(window.scrollY / 700, 1);
  document.documentElement.style.setProperty("--flow-scroll", progress.toFixed(3));
};

const requestFlowMotion = () => {
  if (flowFrame) return;
  flowFrame = window.requestAnimationFrame(syncFlowMotion);
};

const closeMenu = () => {
  menuToggle?.setAttribute("aria-expanded", "false");
  menuToggle?.setAttribute("aria-label", "Открыть меню");
  mobileMenu?.classList.remove("is-open");
  header?.classList.remove("menu-visible");
  document.body.classList.remove("menu-open");
};

menuToggle?.addEventListener("click", () => {
  const willOpen = menuToggle.getAttribute("aria-expanded") !== "true";

  menuToggle.setAttribute("aria-expanded", String(willOpen));
  menuToggle.setAttribute("aria-label", willOpen ? "Закрыть меню" : "Открыть меню");
  mobileMenu?.classList.toggle("is-open", willOpen);
  header?.classList.toggle("menu-visible", willOpen);
  document.body.classList.toggle("menu-open", willOpen);
});

mobileMenu?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", closeMenu);
});

window.addEventListener("scroll", syncHeader, { passive: true });
window.addEventListener("scroll", requestFlowMotion, { passive: true });
window.addEventListener("resize", () => {
  if (window.innerWidth > 820) closeMenu();
});
syncHeader();
syncFlowMotion();

const revealObserver = new IntersectionObserver(
  (entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    });
  },
  {
    rootMargin: "0px 0px -8% 0px",
    threshold: 0.12,
  },
);

document.querySelectorAll(".reveal").forEach((element) => {
  revealObserver.observe(element);
});

const filterButtons = document.querySelectorAll("[data-filter]");
const projectCards = document.querySelectorAll("[data-category]");
const projectGrid = document.querySelector(".project-grid");
const projectCount = document.querySelector("[data-project-count]");
const projectViewer = document.querySelector("[data-project-viewer]");
const projectViewerImage = document.querySelector("[data-project-viewer-image]");
const projectViewerTitle = document.querySelector("[data-project-viewer-title]");
const projectViewerMeta = document.querySelector("[data-project-viewer-meta]");
const projectViewerDescription = document.querySelector("[data-project-viewer-description]");
const projectViewerClose = document.querySelector("[data-project-viewer-close]");
const projectViewerAction = document.querySelector("[data-project-viewer-action]");
const guideTabs = document.querySelectorAll("[data-guide-tab]");
const guidePanels = document.querySelectorAll("[data-guide-panel]");

const formatProjectCount = (count) => {
  const lastTwoDigits = count % 100;
  const lastDigit = count % 10;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) return `${count} кадров`;
  if (lastDigit === 1) return `${count} кадр`;
  if (lastDigit >= 2 && lastDigit <= 4) return `${count} кадра`;
  return `${count} кадров`;
};

const updateProjectCount = () => {
  if (!projectCount) return;

  const visibleCards = [...projectCards].filter(
    (card) => !card.classList.contains("is-hidden"),
  );
  projectCount.textContent = formatProjectCount(visibleCards.length);
};

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const selectedFilter = button.dataset.filter;

    filterButtons.forEach((item) => {
      const isActive = item === button;
      item.classList.toggle("active", isActive);
      item.setAttribute("aria-pressed", String(isActive));
    });

    projectCards.forEach((card) => {
      const shouldShow =
        selectedFilter === "all" || card.dataset.category === selectedFilter;
      card.classList.toggle("is-hidden", !shouldShow);
    });

    projectGrid?.classList.toggle("is-filtered", selectedFilter !== "all");
    updateProjectCount();
  });
});

const closeProjectViewer = () => {
  if (!projectViewer?.open) return;
  projectViewer.close();
};

projectCards.forEach((card) => {
  card.addEventListener("click", () => {
    if (
      !projectViewer ||
      !projectViewerImage ||
      !projectViewerTitle ||
      !projectViewerMeta ||
      !projectViewerDescription
    ) {
      return;
    }

    const title = card.dataset.projectTitle || "Выполненный проект";
    projectViewerImage.src = card.dataset.projectImage || "";
    projectViewerImage.alt = title;
    projectViewerTitle.textContent = title;
    projectViewerMeta.textContent = card.dataset.projectMeta || "";
    projectViewerDescription.textContent = card.dataset.projectDescription || "";
    projectViewer.showModal();
    document.body.classList.add("viewer-open");
  });
});

projectViewerClose?.addEventListener("click", closeProjectViewer);
projectViewerAction?.addEventListener("click", (event) => {
  event.preventDefault();
  closeProjectViewer();
  window.history.pushState(null, "", "#contact");
  window.requestAnimationFrame(() => {
    document.querySelector("#contact")?.scrollIntoView({ behavior: "smooth" });
  });
});

projectViewer?.addEventListener("click", (event) => {
  if (event.target === projectViewer) closeProjectViewer();
});

projectViewer?.addEventListener("close", () => {
  document.body.classList.remove("viewer-open");
  if (projectViewerImage) projectViewerImage.src = "";
});

updateProjectCount();

const selectGuideTab = (selectedTab) => {
  const selectedGuide = selectedTab.dataset.guideTab;

  guideTabs.forEach((tab) => {
    const isSelected = tab === selectedTab;
    tab.setAttribute("aria-selected", String(isSelected));
    tab.tabIndex = isSelected ? 0 : -1;
  });

  guidePanels.forEach((panel) => {
    panel.hidden = panel.dataset.guidePanel !== selectedGuide;
  });
};

guideTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectGuideTab(tab));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

    event.preventDefault();
    let nextIndex = index;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + guideTabs.length) % guideTabs.length;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % guideTabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = guideTabs.length - 1;

    const nextTab = guideTabs[nextIndex];
    nextTab.focus();
    selectGuideTab(nextTab);
  });
});

document.querySelectorAll("[data-service-link]").forEach((link) => {
  link.addEventListener("click", () => {
    if (serviceSelect) serviceSelect.value = link.dataset.serviceLink || "";
  });
});

function formatRussianPhone(value) {
  let digits = value.replace(/\D/g, "");

  if (digits.startsWith("7") || digits.startsWith("8")) {
    digits = digits.slice(1);
  }

  digits = digits.slice(0, 10);

  let formatted = "+7";
  if (digits.length > 0) formatted += ` (${digits.slice(0, 3)}`;
  if (digits.length >= 3) formatted += ")";
  if (digits.length > 3) formatted += ` ${digits.slice(3, 6)}`;
  if (digits.length > 6) formatted += `-${digits.slice(6, 8)}`;
  if (digits.length > 8) formatted += `-${digits.slice(8, 10)}`;

  return formatted;
}

function syncPhoneInput() {
  if (!phoneInput) return;

  phoneInput.value = formatRussianPhone(phoneInput.value);
  const digitCount = phoneInput.value.replace(/\D/g, "").length;
  phoneInput.setCustomValidity(
    digitCount === 11 ? "" : "Введите полный номер в формате +7 (999) 123-45-67",
  );
}

phoneInput?.addEventListener("input", syncPhoneInput);
phoneInput?.addEventListener("focus", () => {
  window.requestAnimationFrame(() => {
    phoneInput.setSelectionRange(phoneInput.value.length, phoneInput.value.length);
  });
});
syncPhoneInput();

form?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!form.checkValidity()) {
    form.reportValidity();
    formStatus.dataset.state = "error";
    formStatus.textContent = "Проверьте имя, телефон и выбранное направление.";
    return;
  }

  const payload = {
    ...Object.fromEntries(new FormData(form).entries()),
    page: window.location.href,
  };
  const endpoint = window.AMALGAMA_LEAD_ENDPOINT || "/api/site-leads";
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);

  form.setAttribute("aria-busy", "true");
  formStatus.dataset.state = "sending";
  formStatus.textContent = "Отправляем заявку…";
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Отправляем…";
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result.ok) throw new Error("Request failed");

    form.reset();
    syncPhoneInput();
    formStatus.dataset.state = "success";
    formStatus.textContent =
      "Заявка отправлена. Спасибо! Мы свяжемся с вами в ближайшее время.";
  } catch {
    formStatus.dataset.state = "error";
    formStatus.textContent =
      "Не удалось отправить заявку. Проверьте соединение и попробуйте ещё раз.";
  } finally {
    window.clearTimeout(timeout);
    form.removeAttribute("aria-busy");
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = "Отправить заявку";
    }
  }
});

if (year) year.textContent = new Date().getFullYear();
