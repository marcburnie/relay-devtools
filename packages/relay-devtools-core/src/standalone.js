/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { createElement } from 'react';
import {
  // $FlowFixMe Flow does not yet know about flushSync()
  flushSync,
  // $FlowFixMe Flow does not yet know about createRoot()
  unstable_createRoot as createRoot,
} from 'react-dom';
import Bridge from 'src/bridge';
import Store from 'src/devtools/store';
import { Server } from 'ws';
import { existsSync, readFileSync } from 'fs';
import { installHook } from 'src/hook';
import DevTools from 'src/devtools/views/DevTools';
import { __DEBUG__ } from 'src/constants';

import type { FrontendBridge } from 'src/bridge';

installHook(window);

export type StatusListener = (message: string) => void;

let node: HTMLElement = ((null: any): HTMLElement);
let nodeWaitingToConnectHTML: string = '';
let statusListener: StatusListener = (message: string) => {};

function setContentDOMNode(value: HTMLElement) {
  node = value;

  // Save so we can restore the exact waiting message between sessions.
  nodeWaitingToConnectHTML = node.innerHTML;

  return DevtoolsUI;
}

function setStatusListener(value: StatusListener) {
  statusListener = value;
  return DevtoolsUI;
}

let bridge: FrontendBridge | null = null;
let store: Store | null = null;
let root = null;

const log = (...args) => console.log('[Relay DevTools]', ...args);
log.warn = (...args) => console.warn('[Relay DevTools]', ...args);
log.error = (...args) => console.error('[Relay DevTools]', ...args);

function debug(methodName: string, ...args) {
  if (__DEBUG__) {
    console.log(
      `%c[core/standalone] %c${methodName}`,
      'color: teal; font-weight: bold;',
      'font-weight: bold;',
      ...args
    );
  }
}

function safeUnmount() {
  flushSync(() => {
    if (root !== null) {
      root.unmount();
    }
  });
  root = null;
}

function reload() {
  safeUnmount();

  node.innerHTML = '';

  setTimeout(() => {
    root = createRoot(node);
    root.render(
      createElement(DevTools, {
        bridge: ((bridge: any): FrontendBridge),
        showTabBar: true,
        store: ((store: any): Store),
        viewElementSourceRequiresFileLocation: true,
      })
    );
  }, 100);
}

function onDisconnected() {
  safeUnmount();

  node.innerHTML = nodeWaitingToConnectHTML;
}

function onError({ code, message }) {
  safeUnmount();

  if (code === 'EADDRINUSE') {
    node.innerHTML = `<div id="waiting"><h2>Another instance of DevTools is running</h2></div>`;
  } else {
    node.innerHTML = `<div id="waiting"><h2>Unknown error (${message})</h2></div>`;
  }
}

function initialize(socket: WebSocket) {
  const listeners = [];
  socket.onmessage = event => {
    let data;
    try {
      if (typeof event.data === 'string') {
        data = JSON.parse(event.data);

        if (__DEBUG__) {
          debug('WebSocket.onmessage', data);
        }
      } else {
        throw Error();
      }
    } catch (e) {
      log.error('Failed to parse JSON', event.data);
      return;
    }
    listeners.forEach(fn => {
      try {
        fn(data);
      } catch (error) {
        log.error('Error calling listener', data);
        throw error;
      }
    });
  };

  bridge = new Bridge({
    listen(fn) {
      listeners.push(fn);
      return () => {
        const index = listeners.indexOf(fn);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    },
    send(event: string, payload: any, transferable?: Array<any>) {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ event, payload }));
      }
    },
  });
  ((bridge: any): FrontendBridge).addListener('shutdown', () => {
    socket.close();
  });

  store = new Store(bridge);

  log('Connected');
  reload();
}

let startServerTimeoutID: TimeoutID | null = null;

function connectToSocket(socket: WebSocket) {
  socket.onerror = err => {
    onDisconnected();
    log.error('Error with websocket connection', err);
  };
  socket.onclose = () => {
    onDisconnected();
    log('Connection to RN closed');
  };
  initialize(socket);

  return {
    close: function() {
      onDisconnected();
    },
  };
}

function startServer(port?: number = 8097) {
  const httpServer = require('http').createServer();
  const server = new Server({ server: httpServer });
  let connected: WebSocket | null = null;
  server.on('connection', (socket: WebSocket) => {
    if (connected !== null) {
      connected.close();
      log.warn(
        'Only one connection allowed at a time.',
        'Closing the previous connection'
      );
    }
    connected = socket;
    socket.onerror = error => {
      connected = null;
      onDisconnected();
      log.error('Error with websocket connection', error);
    };
    socket.onclose = () => {
      connected = null;
      onDisconnected();
      log('Connection to RN closed');
    };
    initialize(socket);
  });

  server.on('error', event => {
    onError(event);
    log.error('Failed to start the DevTools server', event);
    startServerTimeoutID = setTimeout(() => startServer(port), 1000);
  });

  httpServer.on('request', (request, response) => {
    // NPM installs should read from node_modules,
    // But local dev mode needs to use a relative path.
    const basePath = existsSync('./node_modules/relay-devtools-core')
      ? 'node_modules/relay-devtools-core'
      : '../relay-devtools-core';

    // Serve a file that immediately sets up the connection.
    const backendFile = readFileSync(`${basePath}/dist/backend.js`);

    response.end(
      backendFile.toString() +
        '\n;' +
        'RelayDevToolsBackend.connectToDevTools();'
    );
  });

  httpServer.on('error', event => {
    onError(event);
    statusListener('Failed to start the server.');
    startServerTimeoutID = setTimeout(() => startServer(port), 1000);
  });

  httpServer.listen(port, () => {
    statusListener('The server is listening on the port ' + port + '.');
  });

  return {
    close: function() {
      connected = null;
      onDisconnected();
      clearTimeout(startServerTimeoutID);
      server.close();
      httpServer.close();
    },
  };
}

const DevtoolsUI = {
  connectToSocket,
  setContentDOMNode,
  setStatusListener,
  startServer,
};

export default DevtoolsUI;
