const STORAGE_KEY = "profile";

const FIELD_NAMES = [
  "fullName",
  "firstName",
  "lastName",
  "email",
  "phone",
  "location",
  "lastCtc",
  "expectedCtc",
  "noticePeriod",
  "totalExperience",
  "linkedinUrl",
  "githubUrl",
  "portfolioUrl",
  "skills",
  "workAuthorization"
];

const form = document.getElementById("profile-form");
const statusEl = document.getElementById("status");
const autofillButton = document.getElementById("autofill-page");

document.addEventListener("DOMContentLoaded", async () => {
  await loadProfile();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const profile = buildProfileFromForm();
  const validationError = validateProfile(profile);

  if (validationError) {
    setStatus(validationError, "error");
    return;
  }

  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: profile });
    setStatus("Saved successfully!", "success");
  } catch (error) {
    setStatus(`Unable to save details: ${error.message}`, "error");
  }
});

autofillButton.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) {
      setStatus("No active tab found.", "error");
      return;
    }

    const response = await sendAutofillMessage(tab.id);

    if (response?.ok) {
      const summary = response.filledCount
        ? `Autofill complete: ${response.filledCount} field${response.filledCount === 1 ? "" : "s"} filled.`
        : response.message || "No matching empty fields found.";
      setStatus(summary, "success");
      return;
    }

    setStatus(response?.message || "Autofill could not run on this page.", "error");
  } catch (error) {
    setStatus(error.message || "Unable to contact the page. Reload the tab and try again.", "error");
  }
});

async function sendAutofillMessage(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "AUTOFILL_PAGE" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });

    await delay(100);
    return chrome.tabs.sendMessage(tabId, { type: "AUTOFILL_PAGE" });
  }
}

async function loadProfile() {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const profile = result?.[STORAGE_KEY] || {};

    for (const fieldName of FIELD_NAMES) {
      const input = document.getElementById(fieldName);
      if (input) {
        input.value = profile[fieldName] || "";
      }
    }
  } catch (error) {
    setStatus(`Unable to load saved details: ${error.message}`, "error");
  }
}

function buildProfileFromForm() {
  const profile = {};

  for (const fieldName of FIELD_NAMES) {
    const input = document.getElementById(fieldName);
    profile[fieldName] = normalizeValue(input?.value || "");
  }

  if (!profile.fullName && profile.firstName && profile.lastName) {
    profile.fullName = `${profile.firstName} ${profile.lastName}`.trim();
  }

  return profile;
}

function validateProfile(profile) {
  if (profile.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) {
    return "Enter a valid email address.";
  }

  if (profile.phone && profile.phone.replace(/[^\d+]/g, "").length < 7) {
    return "Enter a valid phone number.";
  }

  const urlFields = ["linkedinUrl", "githubUrl", "portfolioUrl"];

  for (const field of urlFields) {
    if (profile[field] && !isValidUrl(profile[field])) {
      return "Enter valid profile URLs including http:// or https://.";
    }
  }

  return "";
}

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeValue(value) {
  return value.trim();
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function setStatus(message, tone) {
  statusEl.textContent = message;
  statusEl.className = `status ${tone || ""}`.trim();
}
