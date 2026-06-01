import { describe, it, expect } from 'vitest';
import { parseCommand } from './protocol.js';

// Helper to create command JSON string
const cmd = (obj: object) => JSON.stringify(obj);

describe('parseCommand', () => {
  describe('navigation', () => {
    it('should parse navigate command', () => {
      const result = parseCommand(cmd({ id: '1', action: 'navigate', url: 'https://example.com' }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.command.action).toBe('navigate');
        expect(result.command.url).toBe('https://example.com');
      }
    });

    it('should reject navigate without url', () => {
      const result = parseCommand(cmd({ id: '1', action: 'navigate' }));
      expect(result.success).toBe(false);
    });

    it('should parse back command', () => {
      const result = parseCommand(cmd({ id: '1', action: 'back' }));
      expect(result.success).toBe(true);
    });

    it('should parse forward command', () => {
      const result = parseCommand(cmd({ id: '1', action: 'forward' }));
      expect(result.success).toBe(true);
    });

    it('should parse reload command', () => {
      const result = parseCommand(cmd({ id: '1', action: 'reload' }));
      expect(result.success).toBe(true);
    });
  });

  describe('click', () => {
    it('should parse click command', () => {
      const result = parseCommand(cmd({ id: '1', action: 'click', selector: '#btn' }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.command.action).toBe('click');
        expect(result.command.selector).toBe('#btn');
      }
    });

    it('should reject click without selector', () => {
      const result = parseCommand(cmd({ id: '1', action: 'click' }));
      expect(result.success).toBe(false);
    });
  });

  describe('type', () => {
    it('should parse type command', () => {
      const result = parseCommand(
        cmd({ id: '1', action: 'type', selector: '#input', text: 'hello' })
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.command.action).toBe('type');
        expect(result.command.selector).toBe('#input');
        expect(result.command.text).toBe('hello');
      }
    });
  });

  describe('fill', () => {
    it('should parse fill command', () => {
      const result = parseCommand(
        cmd({ id: '1', action: 'fill', selector: '#input', value: 'hello' })
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.command.action).toBe('fill');
        expect(result.command.value).toBe('hello');
      }
    });
  });

  describe('wait', () => {
    it('should parse wait with selector', () => {
      const result = parseCommand(cmd({ id: '1', action: 'wait', selector: '#loading' }));
      expect(result.success).toBe(true);
    });

    it('should parse wait with timeout', () => {
      const result = parseCommand(cmd({ id: '1', action: 'wait', timeout: 5000 }));
      expect(result.success).toBe(true);
    });

    it('should parse wait with text', () => {
      const result = parseCommand(cmd({ id: '1', action: 'wait', text: 'Welcome' }));
      expect(result.success).toBe(true);
    });
  });

  describe('screenshot', () => {
    it('should parse screenshot command', () => {
      const result = parseCommand(cmd({ id: '1', action: 'screenshot', path: 'test.png' }));
      expect(result.success).toBe(true);
    });

    it('should parse screenshot with fullPage', () => {
      const result = parseCommand(cmd({ id: '1', action: 'screenshot', fullPage: true }));
      expect(result.success).toBe(true);
    });
  });

  describe('cookies', () => {
    it('should parse cookies_get', () => {
      const result = parseCommand(cmd({ id: '1', action: 'cookies_get' }));
      expect(result.success).toBe(true);
    });

    it('should parse cookies_set', () => {
      const result = parseCommand(
        cmd({
          id: '1',
          action: 'cookies_set',
          cookies: [{ name: 'session', value: 'abc123' }],
        })
      );
      expect(result.success).toBe(true);
    });

    it('should parse cookies_clear', () => {
      const result = parseCommand(cmd({ id: '1', action: 'cookies_clear' }));
      expect(result.success).toBe(true);
    });
  });

  describe('storage', () => {
    it('should parse storage_get', () => {
      const result = parseCommand(cmd({ id: '1', action: 'storage_get', type: 'local' }));
      expect(result.success).toBe(true);
    });

    it('should parse storage_set', () => {
      const result = parseCommand(
        cmd({
          id: '1',
          action: 'storage_set',
          type: 'local',
          key: 'test',
          value: 'value',
        })
      );
      expect(result.success).toBe(true);
    });
  });

  describe('semantic locators', () => {
    it('should parse getbyrole', () => {
      const result = parseCommand(
        cmd({
          id: '1',
          action: 'getbyrole',
          role: 'button',
          subaction: 'click',
        })
      );
      expect(result.success).toBe(true);
    });

    it('should parse getbytext', () => {
      const result = parseCommand(
        cmd({
          id: '1',
          action: 'getbytext',
          text: 'Submit',
          subaction: 'click',
        })
      );
      expect(result.success).toBe(true);
    });

    it('should parse getbylabel', () => {
      const result = parseCommand(
        cmd({
          id: '1',
          action: 'getbylabel',
          label: 'Email',
          subaction: 'fill',
          value: 'test@test.com',
        })
      );
      expect(result.success).toBe(true);
    });
  });

  describe('tabs', () => {
    it('should parse tab_new', () => {
      const result = parseCommand(cmd({ id: '1', action: 'tab_new' }));
      expect(result.success).toBe(true);
    });

    it('should parse tab_list', () => {
      const result = parseCommand(cmd({ id: '1', action: 'tab_list' }));
      expect(result.success).toBe(true);
    });

    it('should parse tab_switch', () => {
      const result = parseCommand(cmd({ id: '1', action: 'tab_switch', index: 0 }));
      expect(result.success).toBe(true);
    });

    it('should parse tab_close', () => {
      const result = parseCommand(cmd({ id: '1', action: 'tab_close' }));
      expect(result.success).toBe(true);
    });
  });

  describe('snapshot', () => {
    it('should parse basic snapshot command', () => {
      const result = parseCommand(cmd({ id: '1', action: 'snapshot' }));
      expect(result.success).toBe(true);
    });

    it('should parse snapshot with interactive filter', () => {
      const result = parseCommand(cmd({ id: '1', action: 'snapshot', interactive: true }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.command.interactive).toBe(true);
      }
    });

    it('should parse snapshot with compact filter', () => {
      const result = parseCommand(cmd({ id: '1', action: 'snapshot', compact: true }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.command.compact).toBe(true);
      }
    });

    it('should parse snapshot with maxDepth', () => {
      const result = parseCommand(cmd({ id: '1', action: 'snapshot', maxDepth: 3 }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.command.maxDepth).toBe(3);
      }
    });

    it('should parse snapshot with selector scope', () => {
      const result = parseCommand(cmd({ id: '1', action: 'snapshot', selector: '#main' }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.command.selector).toBe('#main');
      }
    });

    it('should parse snapshot with all options', () => {
      const result = parseCommand(cmd({
        id: '1',
        action: 'snapshot',
        interactive: true,
        compact: true,
        maxDepth: 5,
        selector: '.content',
      }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.command.interactive).toBe(true);
        expect(result.command.compact).toBe(true);
        expect(result.command.maxDepth).toBe(5);
        expect(result.command.selector).toBe('.content');
      }
    });
  });

  describe('launch', () => {
    it('should parse launch command', () => {
      const result = parseCommand(cmd({ id: '1', action: 'launch' }));
      expect(result.success).toBe(true);
    });

    it('should parse launch with headless false', () => {
      const result = parseCommand(cmd({ id: '1', action: 'launch', headless: false }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.command.headless).toBe(false);
      }
    });
  });

  describe('mouse actions', () => {
    it('should parse mousemove', () => {
      const result = parseCommand(cmd({ id: '1', action: 'mousemove', x: 100, y: 200 }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.command.x).toBe(100);
        expect(result.command.y).toBe(200);
      }
    });

    it('should parse mousedown', () => {
      const result = parseCommand(cmd({ id: '1', action: 'mousedown', button: 'left' }));
      expect(result.success).toBe(true);
    });

    it('should parse mouseup', () => {
      const result = parseCommand(cmd({ id: '1', action: 'mouseup', button: 'left' }));
      expect(result.success).toBe(true);
    });

    it('should parse wheel', () => {
      const result = parseCommand(cmd({ id: '1', action: 'wheel', deltaX: 0, deltaY: 100 }));
      expect(result.success).toBe(true);
    });
  });

  describe('scroll', () => {
    it('should parse scroll command', () => {
      const result = parseCommand(cmd({ id: '1', action: 'scroll', direction: 'down', amount: 300 }));
      expect(result.success).toBe(true);
    });

    it('should parse scrollintoview', () => {
      const result = parseCommand(cmd({ id: '1', action: 'scrollintoview', selector: '#element' }));
      expect(result.success).toBe(true);
    });
  });

  describe('element state', () => {
    it('should parse isvisible', () => {
      const result = parseCommand(cmd({ id: '1', action: 'isvisible', selector: '#btn' }));
      expect(result.success).toBe(true);
    });

    it('should parse isenabled', () => {
      const result = parseCommand(cmd({ id: '1', action: 'isenabled', selector: '#btn' }));
      expect(result.success).toBe(true);
    });

    it('should parse ischecked', () => {
      const result = parseCommand(cmd({ id: '1', action: 'ischecked', selector: '#checkbox' }));
      expect(result.success).toBe(true);
    });
  });

  describe('viewport and settings', () => {
    it('should parse viewport', () => {
      const result = parseCommand(cmd({ id: '1', action: 'viewport', width: 1920, height: 1080 }));
      expect(result.success).toBe(true);
    });

    it('should parse geolocation', () => {
      const result = parseCommand(cmd({ id: '1', action: 'geolocation', latitude: 37.7749, longitude: -122.4194 }));
      expect(result.success).toBe(true);
    });

    it('should parse offline', () => {
      const result = parseCommand(cmd({ id: '1', action: 'offline', offline: true }));
      expect(result.success).toBe(true);
    });
  });

  describe('trace', () => {
    it('should parse trace_start', () => {
      const result = parseCommand(cmd({ id: '1', action: 'trace_start' }));
      expect(result.success).toBe(true);
    });

    it('should parse trace_stop', () => {
      const result = parseCommand(cmd({ id: '1', action: 'trace_stop', path: 'trace.zip' }));
      expect(result.success).toBe(true);
    });
  });

  describe('console and errors', () => {
    it('should parse console', () => {
      const result = parseCommand(cmd({ id: '1', action: 'console' }));
      expect(result.success).toBe(true);
    });

    it('should parse console with clear', () => {
      const result = parseCommand(cmd({ id: '1', action: 'console', clear: true }));
      expect(result.success).toBe(true);
    });

    it('should parse errors', () => {
      const result = parseCommand(cmd({ id: '1', action: 'errors' }));
      expect(result.success).toBe(true);
    });
  });

  describe('dialog', () => {
    it('should parse dialog accept', () => {
      const result = parseCommand(cmd({ id: '1', action: 'dialog', response: 'accept' }));
      expect(result.success).toBe(true);
    });

    it('should parse dialog dismiss', () => {
      const result = parseCommand(cmd({ id: '1', action: 'dialog', response: 'dismiss' }));
      expect(result.success).toBe(true);
    });

    it('should parse dialog accept with prompt text', () => {
      const result = parseCommand(cmd({ id: '1', action: 'dialog', response: 'accept', promptText: 'hello' }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.command.promptText).toBe('hello');
      }
    });
  });

  describe('frame', () => {
    it('should parse frame command', () => {
      const result = parseCommand(cmd({ id: '1', action: 'frame', selector: '#iframe' }));
      expect(result.success).toBe(true);
    });

    it('should parse mainframe', () => {
      const result = parseCommand(cmd({ id: '1', action: 'mainframe' }));
      expect(result.success).toBe(true);
    });
  });

  describe('invalid commands', () => {
    it('should reject unknown action', () => {
      const result = parseCommand(cmd({ id: '1', action: 'unknown' }));
      expect(result.success).toBe(false);
    });

    it('should reject missing id', () => {
      const result = parseCommand(cmd({ action: 'click', selector: '#btn' }));
      expect(result.success).toBe(false);
    });

    it('should reject invalid JSON', () => {
      const result = parseCommand('not json');
      expect(result.success).toBe(false);
    });
  });
});
