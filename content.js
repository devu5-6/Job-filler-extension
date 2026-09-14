(function initJobFormAutofiller() {
  const STORAGE_KEY = "profile";
  const AUTOFILL_MESSAGE = "AUTOFILL_PAGE";
  const RETRY_DELAYS_MS = [0, 500, 1500, 3000, 5000, 8000];
  const GOOGLE_FORMS_HOST = "docs.google.com";
  const GOOGLE_FORMS_PATH_PREFIX = "/forms";
  const GOOGLE_FORMS_OBSERVER_WINDOW_MS = 12000;

  const FIELD_PATTERNS = {
    firstName: [/\bfirst\s*name\b/, /\bgiven\s*name\b/, /\bfname\b/, /\bforename\b/],
    lastName: [/\blast\s*name\b/, /\bsurname\b/, /\bfamily\s*name\b/, /\blname\b/],
    fullName: [/\bfull\s*name\b/, /\blegal\s*name\b/, /\byour\s*name\b/, /\bapplicant\s*name\b/],
    email: [/\be-?mail\b/, /\bemail\s*address\b/],
    phone: [/\bphone\b/, /\bmobile\b/, /\bcell\b/, /\btelephone\b/, /\bcontact\s*number\b/],
    location: [/\bcity\b/, /\blocation\b/, /\bcurrent\s*location\b/, /\bwhere\s*are\s*you\s*based\b/],
    lastCtc: [
      /\b(?:last|current)\s*(?:ctc|compensation)\b/,
      /\b(?:ctc|compensation)\s*(?:last|current)\b/,
      /\bcurrent\s*salary\b/,
      /\blast\s*salary\b/
    ],
    expectedCtc: [
      /\bexpected\s*(?:ctc|compensation)\b/,
      /\b(?:ctc|compensation)\s*expected\b/,
      /\bexpected\s*salary\b/,
      /\bsalary\s*expectation\b/,
      /\bcompensation\s*expectation\b/
    ],
    noticePeriod: [
      /\bnotice\s*period\b/,
      /\bcurrent\s*notice\s*period\b/,
      /\bjoining\s*(?:period|time)\b/,
      /\bavailability\s*(?:to\s*join|period|date)?\b/,
      /\bavailable\s*to\s*join\b/,
      /\bwhen\s*can\s*you\s*join\b/,
      /\bearliest\s*(?:start|joining)\s*date\b/
    ],
    totalExperience: [
      /\btotal\s*experience\b/,
      /\byears?\s*of\s*experience\b/,
      /\bexperience\s*(?:in\s*years?|years?)\b/,
      /\bwork\s*experience\b/,
      /\bprofessional\s*experience\b/,
      /\boverall\s*experience\b/
    ],
    linkedinUrl: [/\blinked[\s-]?in\b/, /\blinkedin\s*profile\b/],
    githubUrl: [/\bgithub\b/, /\bgithub\s*profile\b/],
    portfolioUrl: [/\bportfolio\b/, /\bwebsite\b/, /\bpersonal\s*site\b/, /\bhomepage\b/],
    skills: [/\bskills?\b/, /\btechnical\s*skills?\b/, /\bcore\s*competencies\b/, /\bexpertise\b/],
    workAuthorization: [
      /\bwork\s*authorization\b/,
      /\bauthorized\s*to\s*work\b/,
      /\brequire\s*sponsorship\b/,
      /\bneed\s*sponsorship\b/,
      /\bsponsorship\b/,
      /\bvisa\s*sponsorship\b/
    ]
  };

  const YES_PATTERNS = [/\byes\b/, /\bauthorized\b/, /\bno sponsorship\b/, /\bnot require sponsorship\b/];
  const NO_PATTERNS = [/\bno\b/, /\brequire sponsorship\b/, /\bneed sponsorship\b/];
  const FIELD_SELECTOR = [
    "input",
    "textarea",
    "select",
    "[role='textbox']",
    "[contenteditable='true']",
    "[contenteditable='plaintext-only']"
  ].join(", ");
  const GOOGLE_FORMS_CONTAINER_SELECTORS = [
    "[role='listitem']",
    ".Qr7Oae",
    ".geS5n",
    ".o3Dpx",
    ".m2",
    ".KHxj8b"
  ].join(", ");
  const GOOGLE_FORMS_TITLE_SELECTORS = [
    "[role='heading']",
    "[data-item-title]",
    ".M7eMe",
    ".HoXoMd",
    ".zMKNVc",
    ".F9yp7e"
  ];

  const isGoogleFormsPage =
    window.location.hostname === GOOGLE_FORMS_HOST &&
    window.location.pathname.startsWith(GOOGLE_FORMS_PATH_PREFIX);

  let autoFillStarted = false;
  let observerDisconnectHandle = null;
  let lastFieldSignature = "";

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== AUTOFILL_MESSAGE) {
      return false;
    }

    runAutofill({ manual: true })
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, filledCount: 0, skippedCount: 0, message: error.message }));

    return true;
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      scheduleAutofill();
    }, { once: true });
  } else {
    scheduleAutofill();
  }

  function scheduleAutofill() {
    if (autoFillStarted) {
      return;
    }

    autoFillStarted = true;

    for (const delay of RETRY_DELAYS_MS) {
      window.setTimeout(() => {
        runAutofill({ manual: false }).catch(() => {});
      }, delay);
    }

    if (isGoogleFormsPage) {
      observeGoogleFormsMounting();
    }
  }

  function observeGoogleFormsMounting() {
    const observer = new MutationObserver(() => {
      window.clearTimeout(observerDisconnectHandle);
      observerDisconnectHandle = window.setTimeout(() => observer.disconnect(), 1000);
      runAutofill({ manual: false }).catch(() => {});
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    window.setTimeout(() => observer.disconnect(), GOOGLE_FORMS_OBSERVER_WINDOW_MS);
  }

  async function runAutofill({ manual }) {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const profile = normalizeProfile(result?.[STORAGE_KEY]);

    if (!hasProfileData(profile)) {
      return {
        ok: false,
        filledCount: 0,
        skippedCount: 0,
        message: "No saved profile details found."
      };
    }

    const fields = collectFields();
    if (!fields.length) {
      return {
        ok: false,
        filledCount: 0,
        skippedCount: 0,
        message: "No supported form fields detected on this page."
      };
    }

    const signature = createFieldSignature(fields);
    if (!manual && signature === lastFieldSignature) {
      return {
        ok: true,
        filledCount: 0,
        skippedCount: 0,
        message: "No new matching fields detected."
      };
    }
    lastFieldSignature = signature;

    const fillPlan = buildFillPlan(fields, profile);
    const stats = applyFillPlan(fillPlan, profile);

    return {
      ok: true,
      filledCount: stats.filledCount,
      skippedCount: stats.skippedCount,
      message: stats.filledCount ? "Autofill complete." : "No matching empty fields found."
    };
  }

  function normalizeProfile(profile = {}) {
    return {
      fullName: (profile.fullName || "").trim(),
      firstName: (profile.firstName || "").trim(),
      lastName: (profile.lastName || "").trim(),
      email: (profile.email || "").trim(),
      phone: (profile.phone || "").trim(),
      location: (profile.location || "").trim(),
      lastCtc: (profile.lastCtc || "").trim(),
      expectedCtc: (profile.expectedCtc || "").trim(),
      noticePeriod: (profile.noticePeriod || "").trim(),
      totalExperience: (profile.totalExperience || "").trim(),
      linkedinUrl: (profile.linkedinUrl || "").trim(),
      githubUrl: (profile.githubUrl || "").trim(),
      portfolioUrl: (profile.portfolioUrl || "").trim(),
      skills: (profile.skills || "").trim(),
      workAuthorization: (profile.workAuthorization || "").trim().toLowerCase()
    };
  }

  function hasProfileData(profile) {
    return Object.values(profile).some(Boolean);
  }

  function collectFields() {
    return getQueryableRoots()
      .flatMap((root) => Array.from(root.querySelectorAll(FIELD_SELECTOR)))
      .filter((element, index, elements) => elements.indexOf(element) === index)
      .filter(isSupportedField)
      .map((element) => ({
        element,
        type: getFieldType(element),
        context: buildContext(element),
        questionText: normalizeText(getGoogleFormsQuestionText(element))
      }))
      .filter((descriptor) => descriptor.context);
  }

  function isSupportedField(element) {
    if (!element || element.disabled || element.readOnly) {
      return false;
    }

    if (element.matches("[contenteditable='false']")) {
      return false;
    }

    const tagName = element.tagName.toLowerCase();
    if (tagName === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      const unsupportedTypes = new Set(["hidden", "submit", "button", "file", "image", "reset", "password"]);
      if (unsupportedTypes.has(type)) {
        return false;
      }
    }

    return isElementVisible(element);
  }

  function isElementVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    if (rect.width === 0 && rect.height === 0) {
      return false;
    }

    return true;
  }

  function getFieldType(element) {
    if (element.matches("[role='textbox']")) {
      return element.getAttribute("aria-multiline") === "true" ? "textarea" : "text";
    }

    if (element.isContentEditable) {
      return "contenteditable";
    }

    if (element.tagName.toLowerCase() === "input") {
      return (element.type || "text").toLowerCase();
    }

    return element.tagName.toLowerCase();
  }

  function buildContext(element) {
    const parts = [
      getLabelText(element),
      element.placeholder || "",
      element.name || "",
      element.id || "",
      element.getAttribute("aria-label") || "",
      getAriaLabelledByText(element),
      getAriaDescribedByText(element),
      getNearbyContextText(element),
      getGoogleFormsQuestionText(element)
    ];

    return normalizeText(parts.filter(Boolean).join(" "));
  }

  function getLabelText(element) {
    const labels = [];

    if (element.id) {
      const explicitLabel = document.querySelector(`label[for="${cssEscape(element.id)}"]`);
      if (explicitLabel) {
        labels.push(explicitLabel.innerText || explicitLabel.textContent || "");
      }
    }

    const wrappingLabel = element.closest("label");
    if (wrappingLabel) {
      labels.push(wrappingLabel.innerText || wrappingLabel.textContent || "");
    }

    return labels.join(" ");
  }

  function getAriaLabelledByText(element) {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (!labelledBy) {
      return "";
    }

    return labelledBy
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((node) => node.innerText || node.textContent || "")
      .join(" ");
  }

  function getAriaDescribedByText(element) {
    const describedBy = element.getAttribute("aria-describedby");
    if (!describedBy) {
      return "";
    }

    return describedBy
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((node) => node.innerText || node.textContent || "")
      .join(" ");
  }

  function getNearbyContextText(element) {
    const container = element.closest("div, fieldset, section, article, li, td, th, form");
    if (!container) {
      return "";
    }

    const text = container.innerText || container.textContent || "";
    return text.trim().slice(0, 400);
  }

  function getGoogleFormsQuestionText(element) {
    if (!isGoogleFormsPage) {
      return "";
    }

    const container = element.closest(GOOGLE_FORMS_CONTAINER_SELECTORS);
    if (!container) {
      return "";
    }

    for (const selector of GOOGLE_FORMS_TITLE_SELECTORS) {
      const titleNode = container.querySelector(selector);
      if (titleNode?.innerText) {
        return titleNode.innerText;
      }
    }

    const fallbackText = (container.innerText || container.textContent || "").trim();
    return fallbackText.slice(0, 400);
  }

  function normalizeText(text) {
    return text.toLowerCase().replace(/\s+/g, " ").trim();
  }

  function getQueryableRoots() {
    const roots = [];
    const visited = new Set();

    addRoot(document);

    return roots;

    function addRoot(root) {
      if (!root || visited.has(root)) {
        return;
      }

      visited.add(root);
      roots.push(root);

      const treeWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let currentNode = treeWalker.currentNode;

      while (currentNode) {
        if (currentNode.shadowRoot) {
          addRoot(currentNode.shadowRoot);
        }

        if (currentNode.tagName === "IFRAME") {
          const frameRoot = getSameOriginFrameRoot(currentNode);
          if (frameRoot) {
            addRoot(frameRoot);
          }
        }

        currentNode = treeWalker.nextNode();
      }
    }
  }

  function getSameOriginFrameRoot(frame) {
    try {
      return frame.contentDocument || frame.contentWindow?.document || null;
    } catch {
      return null;
    }
  }

  function createFieldSignature(fields) {
    return fields
      .map((field) => `${field.type}:${field.context}:${field.element.name || ""}:${field.element.id || ""}`)
      .join("|");
  }

  function buildFillPlan(fields, profile) {
    const plan = new Map();

    for (const descriptor of fields) {
      const match = matchField(descriptor, fields, profile);
      if (match) {
        plan.set(descriptor.element, match);
      }
    }

    return plan;
  }

  function matchField(descriptor, allFields, profile) {
    const { element, context, type } = descriptor;

    if (!context || isFilled(element)) {
      return null;
    }

    if (type === "radio") {
      if (matchesPatterns(context, FIELD_PATTERNS.workAuthorization) && profile.workAuthorization) {
        return { fieldKey: "workAuthorization", mode: "radio" };
      }
      return null;
    }

    if (matchesPatterns(context, FIELD_PATTERNS.firstName) && profile.firstName) {
      return { fieldKey: "firstName" };
    }

    if (matchesPatterns(context, FIELD_PATTERNS.lastName) && profile.lastName) {
      return { fieldKey: "lastName" };
    }

    if (matchesPatterns(context, FIELD_PATTERNS.fullName) && profile.fullName) {
      return { fieldKey: "fullName" };
    }

    if (isGenericNameField(context) && shouldUseGenericNameField(descriptor, allFields, profile)) {
      return { fieldKey: "fullName" };
    }

    if (matchesPatterns(context, FIELD_PATTERNS.email) && profile.email) {
      return { fieldKey: "email" };
    }

    if (matchesPatterns(context, FIELD_PATTERNS.phone) && profile.phone) {
      return { fieldKey: "phone" };
    }

    if (matchesPatterns(context, FIELD_PATTERNS.location) && profile.location) {
      return { fieldKey: "location" };
    }

    const compensationMatch = matchCompensationField(context, profile);
    if (compensationMatch) {
      return compensationMatch;
    }

    if (matchesPatterns(context, FIELD_PATTERNS.noticePeriod) && profile.noticePeriod) {
      return { fieldKey: "noticePeriod" };
    }

    if (matchesPatterns(context, FIELD_PATTERNS.totalExperience) && profile.totalExperience) {
      return { fieldKey: "totalExperience" };
    }

    if (matchesPatterns(context, FIELD_PATTERNS.linkedinUrl) && profile.linkedinUrl) {
      return { fieldKey: "linkedinUrl" };
    }

    if (matchesPatterns(context, FIELD_PATTERNS.githubUrl) && profile.githubUrl) {
      return { fieldKey: "githubUrl" };
    }

    if (matchesPatterns(context, FIELD_PATTERNS.portfolioUrl) && profile.portfolioUrl) {
      return { fieldKey: "portfolioUrl" };
    }

    if (matchesPatterns(context, FIELD_PATTERNS.skills) && profile.skills) {
      return { fieldKey: "skills" };
    }

    if (matchesPatterns(context, FIELD_PATTERNS.workAuthorization) && profile.workAuthorization) {
      return { fieldKey: "workAuthorization", mode: element.tagName.toLowerCase() === "select" ? "select" : "text" };
    }

    return null;
  }

  function matchesPatterns(context, patterns) {
    return patterns.some((pattern) => pattern.test(context));
  }

  function matchCompensationField(context, profile) {
    const lastIndex = getFirstPatternIndex(context, FIELD_PATTERNS.lastCtc);
    const expectedIndex = getFirstPatternIndex(context, FIELD_PATTERNS.expectedCtc);

    if (lastIndex === -1 && expectedIndex === -1) {
      return null;
    }

    if (expectedIndex !== -1 && (lastIndex === -1 || expectedIndex < lastIndex) && profile.expectedCtc) {
      return { fieldKey: "expectedCtc" };
    }

    if (lastIndex !== -1 && profile.lastCtc) {
      return { fieldKey: "lastCtc" };
    }

    if (expectedIndex !== -1 && profile.expectedCtc) {
      return { fieldKey: "expectedCtc" };
    }

    return null;
  }

  function getFirstPatternIndex(context, patterns) {
    return patterns.reduce((bestIndex, pattern) => {
      const match = context.match(pattern);
      if (!match || match.index === undefined) {
        return bestIndex;
      }

      return bestIndex === -1 ? match.index : Math.min(bestIndex, match.index);
    }, -1);
  }

  function isGenericNameField(context) {
    return /\bname\b/.test(context) &&
      !/\b(company|employer|school|university|referrer|reference|username)\b/.test(context) &&
      !matchesPatterns(context, FIELD_PATTERNS.firstName) &&
      !matchesPatterns(context, FIELD_PATTERNS.lastName);
  }

  function shouldUseGenericNameField(descriptor, allFields, profile) {
    if (!profile.fullName) {
      return false;
    }

    if (isGoogleFormsStandaloneNameField(descriptor)) {
      return true;
    }

    const hasSplitNameFields =
      allFields.some((field) => matchesPatterns(field.context, FIELD_PATTERNS.firstName)) &&
      allFields.some((field) => matchesPatterns(field.context, FIELD_PATTERNS.lastName));

    return !hasSplitNameFields;
  }

  function isGoogleFormsStandaloneNameField(descriptor) {
    if (!isGoogleFormsPage) {
      return false;
    }

    const questionText = descriptor.questionText || "";
    const context = descriptor.context || "";

    if (/^name\b/.test(questionText) && !/\b(first|last|full)\s*name\b/.test(questionText)) {
      return true;
    }

    return /\bname\b/.test(context) &&
      !/\b(first|last|full)\s*name\b/.test(context) &&
      !/\b(company|employer|school|university|referrer|reference|username)\b/.test(context);
  }

  function isFilled(element) {
    if (element.tagName.toLowerCase() === "select") {
      return Boolean(element.value && element.value.trim());
    }

    if (element.type === "radio" || element.type === "checkbox") {
      return element.checked;
    }

    if (element.isContentEditable) {
      return Boolean((element.textContent || "").trim());
    }

    return Boolean((element.value || "").trim());
  }

  function applyFillPlan(plan, profile) {
    let filledCount = 0;
    let skippedCount = 0;

    for (const [element, match] of plan.entries()) {
      const value = profile[match.fieldKey];
      if (!value) {
        skippedCount += 1;
        continue;
      }

      if (fillElement(element, value, match.mode)) {
        filledCount += 1;
      } else {
        skippedCount += 1;
      }
    }

    return { filledCount, skippedCount };
  }

  function fillElement(element, value, mode) {
    const target = resolveFillTarget(element, mode);

    if (!target || !isSupportedField(target) || isFilled(target)) {
      return false;
    }

    if (target.type === "radio" || mode === "radio") {
      return fillRadio(target, value);
    }

    if (target.tagName.toLowerCase() === "select" || mode === "select") {
      return fillSelect(target, value);
    }

    if (target.isContentEditable || target.matches("[role='textbox']")) {
      fillEditableTarget(target, value);
      dispatchInputEvents(target);
      return true;
    }

    target.focus();
    setNativeValue(target, value);
    dispatchInputEvents(target);
    return true;
  }

  function resolveFillTarget(element, mode) {
    if (!element) {
      return null;
    }

    if (mode === "radio" || mode === "select") {
      return element;
    }

    if (element.tagName?.toLowerCase() === "input" || element.tagName?.toLowerCase() === "textarea") {
      return element;
    }

    const nestedInput = element.querySelector?.("input, textarea, select");
    if (nestedInput) {
      return nestedInput;
    }

    return element;
  }

  function fillSelect(element, value) {
    const normalizedChoice = String(value).toLowerCase();
    const options = Array.from(element.options);

    const matchingOption = options.find((option) => {
      const haystack = normalizeText(`${option.label} ${option.text} ${option.value}`);
      if (normalizedChoice === "yes") {
        return YES_PATTERNS.some((pattern) => pattern.test(haystack));
      }
      if (normalizedChoice === "no") {
        return NO_PATTERNS.some((pattern) => pattern.test(haystack));
      }
      return haystack.includes(normalizedChoice);
    });

    if (!matchingOption) {
      return false;
    }

    element.value = matchingOption.value;
    dispatchInputEvents(element);
    return true;
  }

  function fillRadio(element, value) {
    if (!element.name) {
      return false;
    }

    const radioGroup = Array.from(document.querySelectorAll(`input[type="radio"][name="${cssEscape(element.name)}"]`));
    const normalizedChoice = String(value).toLowerCase();

    const target = radioGroup.find((radio) => {
      const context = buildContext(radio);
      const valueText = normalizeText(`${radio.value} ${context}`);
      if (normalizedChoice === "yes") {
        return YES_PATTERNS.some((pattern) => pattern.test(valueText));
      }
      if (normalizedChoice === "no") {
        return NO_PATTERNS.some((pattern) => pattern.test(valueText));
      }
      return valueText.includes(normalizedChoice);
    });

    if (!target) {
      return false;
    }

    target.checked = true;
    dispatchInputEvents(target);
    return true;
  }

  function setNativeValue(element, value) {
    const descriptor = getValuePropertyDescriptor(element);

    if (descriptor?.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function getValuePropertyDescriptor(element) {
    let prototype = element;

    while (prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor?.set) {
        return descriptor;
      }
      prototype = Object.getPrototypeOf(prototype);
    }

    return null;
  }

  function fillEditableTarget(element, value) {
    element.focus();

    if ("value" in element) {
      setNativeValue(element, value);
      return;
    }

    if (element.isContentEditable) {
      element.textContent = value;
      return;
    }

    element.textContent = value;
    element.setAttribute("aria-label", element.getAttribute("aria-label") || "");
  }

  function dispatchInputEvents(element) {
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: null, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function cssEscape(value) {
    if (window.CSS?.escape) {
      return window.CSS.escape(value);
    }

    return String(value).replace(/["\\]/g, "\\$&");
  }
})();
