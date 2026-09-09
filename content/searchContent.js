/**
 * searchContent.js
 * Content script injected into Google Search pages.
 * Handles interruption / CAPTCHA detection and triggers SERP extraction.
 */

(function () {
  'use strict';

  /**
   * Checks if the current page is an interruption, CAPTCHA, or unusual traffic challenge.
   * @returns {boolean}
   */
  function isInterruptedOrCaptcha() {
    // 1. Known Google CAPTCHA / Challenge form selectors
    if (document.querySelector('#captcha-form') ||
        document.querySelector('.g-recaptcha') ||
        document.querySelector('form#challenge-form') ||
        document.querySelector('iframe[src*="recaptcha"]') ||
        document.querySelector('div[id*="recaptcha"]') ||
        document.querySelector('#recaptcha')) {
      return true;
    }

    // 2. Title indicators
    const title = (document.title || '').toLowerCase();
    if (title.includes('sorry...') || title.includes('unusual traffic') || title.includes('attention required')) {
      return true;
    }

    // 3. Body text indicators
    const bodyText = (document.body ? document.body.innerText : '').toLowerCase();
    if (bodyText.includes('unusual traffic from your computer network') ||
        bodyText.includes('our systems have detected unusual traffic') ||
        bodyText.includes('to continue, please type the characters below') ||
        bodyText.includes('please solve this puzzle')) {
      return true;
    }

    return false;
  }

  /**
   * Waits for search results or no-results container to be present in the DOM.
   * @param {number} maxWaitMs 
   * @returns {Promise<boolean>}
   */
  function waitForResultsReady(maxWaitMs = 10000) {
    return new Promise((resolve) => {
      // Check immediately
      if (document.querySelector('#rso') ||
          document.querySelector('#search') ||
          document.querySelector('div.g') ||
          document.querySelector('div.MjjYud') ||
          document.querySelector('#topstuff') ||
          document.querySelector('#fprsl')) {
        return resolve(true);
      }

      const startTime = Date.now();
      const interval = setInterval(() => {
        if (isInterruptedOrCaptcha()) {
          clearInterval(interval);
          return resolve(false);
        }

        if (document.querySelector('#rso') ||
            document.querySelector('#search') ||
            document.querySelector('div.g') ||
            document.querySelector('div.MjjYud') ||
            document.querySelector('#topstuff') ||
            document.querySelector('#fprsl')) {
          clearInterval(interval);
          return resolve(true);
        }

        if (Date.now() - startTime >= maxWaitMs) {
          clearInterval(interval);
          resolve(false);
        }
      }, 250);
    });
  }

  // Listen for messages from background service worker
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'PING') {
      sendResponse({ status: 'PONG' });
      return false;
    }

    if (request.action === 'EXTRACT_SERP') {
      (async () => {
        try {
          // Check for CAPTCHA first
          if (isInterruptedOrCaptcha()) {
            sendResponse({
              status: 'BLOCKED',
              reason: 'CAPTCHA_DETECTED',
              message: 'Google interrupted rank checking. The job has been paused.'
            });
            return;
          }

          // Wait for DOM to finish rendering
          await waitForResultsReady(request.timeout || 8000);

          // Second check for CAPTCHA in case it appeared dynamically
          if (isInterruptedOrCaptcha()) {
            sendResponse({
              status: 'BLOCKED',
              reason: 'CAPTCHA_DETECTED',
              message: 'Google interrupted rank checking. The job has been paused.'
            });
            return;
          }

          // Extract using serpParser
          if (!window.serpParser || typeof window.serpParser.extractOrganicResults !== 'function') {
            sendResponse({
              status: 'ERROR',
              message: 'serpParser module not loaded in page context.'
            });
            return;
          }

          const organicResults = window.serpParser.extractOrganicResults(document, request.debug);

          sendResponse({
            status: 'SUCCESS',
            results: organicResults,
            totalFound: organicResults.length
          });
        } catch (err) {
          sendResponse({
            status: 'ERROR',
            message: err.message || 'Unknown error during SERP extraction'
          });
        }
      })();

      return true; // Keep message channel open for async response
    }
  });
})();
