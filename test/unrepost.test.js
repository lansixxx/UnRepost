const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  evaluateDeleteResponse,
  StateManager,
  findChromeExecutable,
  resolveAppPaths,
  validateLoopbackRequest
} = require('../unrepost.js');

describe('UnRepost Test Suite', () => {

  describe('1. Un-Repost Response Evaluation (evaluateDeleteResponse)', () => {

    it('confirms success only when delete_video_status is 1 and status_code is 0', () => {
      const payload = JSON.stringify({
        status_code: 0,
        status_msg: '',
        delete_result: {
          delete_video_status: 1,
          sync_delete_video: true
        }
      });
      const res = evaluateDeleteResponse(200, payload);
      assert.equal(res.success, true);
      assert.equal(res.statusCode, 0);
      assert.equal(res.rateLimited, false);
      assert.equal(res.isCaptcha, false);
    });

    it('rejects empty response body and marks as rate limit / silent drop', () => {
      const resEmpty = evaluateDeleteResponse(200, '');
      assert.equal(resEmpty.success, false);
      assert.equal(resEmpty.rateLimited, true);
      assert.match(resEmpty.error, /empty response/i);

      const resWhitespace = evaluateDeleteResponse(200, '   \n  ');
      assert.equal(resWhitespace.success, false);
      assert.equal(resWhitespace.rateLimited, true);
    });

    it('rejects unconfirmed delete_video_status: 0 as rate limit / unconfirmed', () => {
      const payload = JSON.stringify({
        status_code: 0,
        delete_result: {
          delete_video_status: 0,
          sync_delete_video: false
        }
      });
      const res = evaluateDeleteResponse(200, payload);
      assert.equal(res.success, false);
      assert.equal(res.rateLimited, true);
    });

    it('identifies TikTok rate-limit code 10202 and throttling keywords', () => {
      const payloadCode = JSON.stringify({
        status_code: 10202,
        status_msg: 'Too frequent, please wait a moment'
      });
      const resCode = evaluateDeleteResponse(200, payloadCode);
      assert.equal(resCode.success, false);
      assert.equal(resCode.rateLimited, true);

      const payloadMsg = JSON.stringify({
        status_code: 10001,
        status_msg: 'Operation is too frequent. Please retry later.'
      });
      const resMsg = evaluateDeleteResponse(200, payloadMsg);
      assert.equal(resMsg.success, false);
      assert.equal(resMsg.rateLimited, true);
    });

    it('handles HTTP 429 and HTTP 503 as rate limit / server throttling', () => {
      const res429 = evaluateDeleteResponse(429, 'Too Many Requests');
      assert.equal(res429.success, false);
      assert.equal(res429.rateLimited, true);
      assert.equal(res429.httpStatus, 429);

      const res503 = evaluateDeleteResponse(503, 'Service Unavailable');
      assert.equal(res503.success, false);
      assert.equal(res503.rateLimited, true);
    });

    it('detects CAPTCHA challenge code 10214', () => {
      const payload = JSON.stringify({
        status_code: 10214,
        status_msg: 'Captcha verification required'
      });
      const res = evaluateDeleteResponse(200, payload);
      assert.equal(res.success, false);
      assert.equal(res.isCaptcha, true);
    });

    it('handles non-JSON error pages gracefully without throwing', () => {
      const res = evaluateDeleteResponse(200, '<html><head><title>Error</title></head><body>502 Bad Gateway</body></html>');
      assert.equal(res.success, false);
      assert.equal(res.rateLimited, false);
      assert.match(res.error, /non-json/i);
    });
  });

  describe('2. State Management & Reconciliation', () => {
    let tmpDir;
    let originalDataDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unrepost-test-'));
      originalDataDir = process.env.UNREPOST_DATA_DIR;
      process.env.UNREPOST_DATA_DIR = tmpDir;
    });

    afterEach(() => {
      if (originalDataDir) {
        process.env.UNREPOST_DATA_DIR = originalDataDir;
      } else {
        delete process.env.UNREPOST_DATA_DIR;
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (e) {}
    });

    it('initializes default counters and status', () => {
      const sm = new StateManager();
      assert.equal(sm.data.status, 'STARTING');
      assert.equal(sm.data.stats.confirmedRemoved, 0);
      assert.equal(sm.data.stats.failedOrSkipped, 0);
      assert.equal(sm.data.stats.unconfirmedOrRetrying, 0);
      assert.deepEqual(sm.data.removedIds, []);
    });

    it('records genuine removals and increments confirmedRemoved', () => {
      const sm = new StateManager();
      sm.recordRemoval('test-id-1', '@author1', 'test video 1');
      assert.equal(sm.data.stats.confirmedRemoved, 1);
      assert.deepEqual(sm.data.removedIds, ['test-id-1']);

      // Deduplication: calling recordRemoval with the same ID should not increment count
      sm.recordRemoval('test-id-1', '@author1', 'duplicate');
      assert.equal(sm.data.stats.confirmedRemoved, 1);
    });

    it('records failures separately from removals', () => {
      const sm = new StateManager();
      sm.recordFailure('failed-id-1', '@author2', 'Original video deleted');
      assert.equal(sm.data.stats.confirmedRemoved, 0);
      assert.equal(sm.data.stats.failedOrSkipped, 1);
      assert.deepEqual(sm.data.failedIds, ['failed-id-1']);
    });

    it('tracks unconfirmed / rate-limited attempts separately', () => {
      const sm = new StateManager();
      sm.recordUnconfirmed('retry-id-1', '@author3', 'TikTok rate limit hit');
      assert.equal(sm.data.stats.confirmedRemoved, 0);
      assert.equal(sm.data.stats.unconfirmedOrRetrying, 1);
      // Unconfirmed items must NEVER be added to removedIds
      assert.equal(sm.data.removedIds.includes('retry-id-1'), false);
    });
  });

  describe('3. Loopback & CSRF Security Validation', () => {

    function mockReq(host, origin, referer) {
      return {
        headers: {
          host,
          ...(origin ? { origin } : {}),
          ...(referer ? { referer } : {})
        }
      };
    }

    function mockRes() {
      const res = {
        statusCode: 200,
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(data) {
          this.body = data;
          return this;
        }
      };
      return res;
    }

    it('permits valid loopback requests from localhost:3210', () => {
      const req = mockReq('localhost:3210', 'http://localhost:3210');
      const res = mockRes();
      let nextCalled = false;
      validateLoopbackRequest(req, res, () => { nextCalled = true; });

      assert.equal(nextCalled, true);
      assert.equal(res.statusCode, 200);
    });

    it('permits valid loopback requests from 127.0.0.1:3210', () => {
      const req = mockReq('127.0.0.1:3210', 'http://127.0.0.1:3210');
      const res = mockRes();
      let nextCalled = false;
      validateLoopbackRequest(req, res, () => { nextCalled = true; });

      assert.equal(nextCalled, true);
    });

    it('blocks requests from external host IP addresses', () => {
      const req = mockReq('192.168.1.150:3210');
      const res = mockRes();
      let nextCalled = false;
      validateLoopbackRequest(req, res, () => { nextCalled = true; });

      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 403);
      assert.match(res.body.error, /loopback only/i);
    });

    it('blocks cross-origin requests from external websites (CSRF attack prevention)', () => {
      const req = mockReq('localhost:3210', 'https://malicious-website.com');
      const res = mockRes();
      let nextCalled = false;
      validateLoopbackRequest(req, res, () => { nextCalled = true; });

      assert.equal(nextCalled, false);
      assert.equal(res.statusCode, 403);
      assert.match(res.body.error, /invalid request origin/i);
    });
  });

  describe('4. Cross-Platform Environment & Path Resolution', () => {
    it('findChromeExecutable returns a string or null without throwing', () => {
      const chrome = findChromeExecutable();
      assert.ok(chrome === null || typeof chrome === 'string');
    });

    it('resolveAppPaths returns dataDir, userDataDir, and stateFile', () => {
      const paths = resolveAppPaths();
      assert.ok(paths.dataDir);
      assert.ok(paths.userDataDir);
      assert.ok(paths.stateFile);
    });
  });
});

