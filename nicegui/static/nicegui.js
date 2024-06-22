const True = true;
const False = false;
const None = undefined;

let app = undefined;
let mounted_app = undefined;

const loaded_libraries = new Set();
const loaded_components = new Set();

function parseElements(raw_elements) {
  return JSON.parse(
    raw_elements
      .replace(/&#36;/g, "$")
      .replace(/&#96;/g, "`")
      .replace(/&gt;/g, ">")
      .replace(/&lt;/g, "<")
      .replace(/&amp;/g, "&")
  );
}

function replaceUndefinedAttributes(elements, id) {
  const element = elements[id];
  if (element === undefined) {
    return;
  }
  element.class ??= [];
  element.style ??= {};
  element.props ??= {};
  element.text ??= null;
  element.events ??= [];
  element.component ??= null;
  element.libraries ??= [];
  element.slots = {
    default: { ids: element.children || [] },
    ...(element.slots ?? {}),
  };
  Object.values(element.slots).forEach((slot) => slot.ids.forEach((id) => replaceUndefinedAttributes(elements, id)));
}

function getElement(id) {
  const _id = id instanceof HTMLElement ? id.id : id;
  return mounted_app.$refs["r" + _id];
}

function runMethod(target, method_name, args) {
  if (typeof target === "object") {
    if (method_name in target) {
      return target[method_name](...args);
    } else {
      return eval(method_name)(target, ...args);
    }
  }
  const element = getElement(target);
  if (element === null || element === undefined) return;
  if (method_name in element) {
    return element[method_name](...args);
  } else if (method_name in (element.$refs.qRef || [])) {
    return element.$refs.qRef[method_name](...args);
  } else {
    return eval(method_name)(element, ...args);
  }
}

function emitEvent(event_name, ...args) {
  getElement(0).$emit(event_name, ...args);
}

function stringifyEventArgs(args, event_args) {
  const result = [];
  args.forEach((arg, i) => {
    if (event_args !== null && i >= event_args.length) return;
    let filtered = {};
    if (typeof arg !== "object" || arg === null || Array.isArray(arg)) {
      filtered = arg;
    } else {
      for (let k in arg) {
        // ignore "Restricted" fields in Firefox (see #2469)
        if (k == "originalTarget") {
          try {
            arg[k].toString();
          } catch (e) {
            continue;
          }
        }
        if (event_args === null || event_args[i] === null || event_args[i].includes(k)) {
          filtered[k] = arg[k];
        }
      }
    }
    result.push(JSON.stringify(filtered, (k, v) => (v instanceof Node || v instanceof Window ? undefined : v)));
  });
  return result;
}

const waitingCallbacks = new Map();
function throttle(callback, time, leading, trailing, id) {
  if (time <= 0) {
    // execute callback immediately and return
    callback();
    return;
  }
  if (waitingCallbacks.has(id)) {
    if (trailing) {
      // update trailing callback
      waitingCallbacks.set(id, callback);
    }
  } else {
    if (leading) {
      // execute leading callback and set timeout to block more leading callbacks
      callback();
      waitingCallbacks.set(id, null);
    } else if (trailing) {
      // set trailing callback and set timeout to execute it
      waitingCallbacks.set(id, callback);
    }
    if (leading || trailing) {
      // set timeout to remove block and to execute trailing callback
      setTimeout(() => {
        const trailingCallback = waitingCallbacks.get(id);
        if (trailingCallback) trailingCallback();
        waitingCallbacks.delete(id);
      }, 1000 * time);
    }
  }
}
function renderRecursively(elements, id) {
  const element = elements[id];
  if (element === undefined) {
    return;
  }

  // @todo: Try avoid this with better handling of initial page load.
  if (element.component) loaded_components.add(element.component.name);
  element.libraries.forEach((library) => loaded_libraries.add(library.name));

  const props = {
    id: "c" + id,
    ref: "r" + id,
    key: id, // HACK: workaround for #600 and #898
    class: element.class.join(" ") || undefined,
    style: Object.entries(element.style).reduce((str, [p, val]) => `${str}${p}:${val};`, "") || undefined,
    ...element.props,
  };
  Object.entries(props).forEach(([key, value]) => {
    if (key.startsWith(":")) {
      try {
        props[key.substring(1)] = eval(value);
        delete props[key];
      } catch (e) {
        console.error(`Error while converting ${key} attribute to function:`, e);
      }
    }
  });
  element.events.forEach((event) => {
    let event_name = "on" + event.type[0].toLocaleUpperCase() + event.type.substring(1);
    event.specials.forEach((s) => (event_name += s[0].toLocaleUpperCase() + s.substring(1)));

    let handler;
    if (event.js_handler) {
      handler = eval(event.js_handler);
    } else {
      handler = (...args) => {
        const data = {
          id: id,
          client_id: window.clientId,
          listener_id: event.listener_id,
          args: stringifyEventArgs(args, event.args),
        };
        const emitter = () => window.socket?.emit("event", data);
        throttle(emitter, event.throttle, event.leading_events, event.trailing_events, event.listener_id);
        if (element.props["loopback"] === False && event.type == "update:modelValue") {
          element.props["model-value"] = args;
        }
      };
    }

    handler = Vue.withModifiers(handler, event.modifiers);
    handler = event.keys.length ? Vue.withKeys(handler, event.keys) : handler;
    if (props[event_name]) {
      props[event_name].push(handler);
    } else {
      props[event_name] = [handler];
    }
  });
  const slots = {};
  const element_slots = {
    default: { ids: element.children || [] },
    ...element.slots,
  };
  Object.entries(element_slots).forEach(([name, data]) => {
    slots[name] = (props) => {
      const rendered = [];
      if (data.template) {
        rendered.push(
          Vue.h(
            {
              props: { props: { type: Object, default: {} } },
              template: data.template,
            },
            {
              props: props,
            }
          )
        );
      }
      const children = data.ids.map((id) => renderRecursively(elements, id));
      if (name === "default" && element.text !== null) {
        children.unshift(element.text);
      }
      return [...rendered, ...children];
    };
  });
  return Vue.h(Vue.resolveComponent(element.tag), props, slots);
}

function runJavascript(code, request_id) {
  new Promise((resolve) => resolve(eval(code)))
    .catch((reason) => {
      if (reason instanceof SyntaxError) return eval(`(async() => {${code}})()`);
      else throw reason;
    })
    .then((result) => {
      if (request_id) {
        window.socket.emit("javascript_response", { request_id, client_id: window.clientId, result });
      }
    });
}

function download(src, filename, mediaType, prefix) {
  const anchor = document.createElement("a");
  if (typeof src === "string") {
    anchor.href = src.startsWith("/") ? prefix + src : src;
  } else {
    anchor.href = URL.createObjectURL(new Blob([src], { type: mediaType }));
  }
  anchor.target = "_blank";
  anchor.download = filename || "";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  if (typeof src !== "string") {
    URL.revokeObjectURL(anchor.href);
  }
}

async function loadDependencies(element, prefix, version) {
  if (element.component) {
    const { name, key, tag } = element.component;
    if (!loaded_components.has(name) && !key.endsWith(".vue")) {
      const component = await import(`${prefix}/_nicegui/${version}/components/${key}`);
      app.component(tag, component.default);
      loaded_components.add(name);
    }
  }
  if (element.libraries) {
    for (const { name, key } of element.libraries) {
      if (loaded_libraries.has(name)) continue;
      await import(`${prefix}/_nicegui/${version}/libraries/${key}`);
      loaded_libraries.add(name);
    }
  }
}

function createRandomUUID() {
  try {
    return crypto.randomUUID();
  } catch (e) {
    // https://stackoverflow.com/a/2117523/3419103
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
      (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (+c / 4)))).toString(16)
    );
  }
}

function processMessageId(event, message) {
  const msgId = message.message_id;
  delete message.message_id;
  delete message.history;

  if (document.title === "XX") {
    return;
  }
  if (msgId <= window.lastMessageId) {
    console.log(`redundant: ${msgId}`, message);
    le(msg);
    document.title = "XX";
    return;
  }
  if (msgId != window.lastMessageId + 1) {
    console.log(`gap detected: ${msgId} -- ${window.lastMessageId}`);
    le(message);
    document.title = "XX";
    return;
  }
  window.lastMessageId = msgId;
  return true;
}

function createApp(elements, options) {
  replaceUndefinedAttributes(elements, 0);
  return (app = Vue.createApp({
    data() {
      return {
        elements,
      };
    },
    render() {
      return renderRecursively(this.elements, 0);
    },
    mounted() {
      mounted_app = this;
      window.clientId = options.query.client_id;
      const url = window.location.protocol === "https:" ? "wss://" : "ws://" + window.location.host;
      window.path_prefix = options.prefix;
      window.lastMessageId = options.query.starting_message_id;
      console.log(`options.query.starting_message_id: ${options.query.starting_message_id}`);
      window.syncing = true;
      window.autoDisconnect = true;
      window.syncingQue = [];

      window.socket = io(url, {
        path: `${options.prefix}/_nicegui_ws/socket.io`,
        query: options.query,
        extraHeaders: options.extraHeaders,
        transports: options.transports,
      });
      const messageHandlers = {
        connect: () => {
          let tabId = sessionStorage.getItem("__nicegui_tab_id");
          if (!tabId) {
            tabId = createRandomUUID();
            sessionStorage.setItem("__nicegui_tab_id", tabId);
          }
          window.retransmitId = createRandomUUID();
          const args = {
            client_id: window.clientId,
            tab_id: tabId,
            last_message_id: window.lastMessageId,
            retransmit_id: window.retransmitId,
          };
          window.socket.emit("handshake", args, (ok) => {
            if (!ok) {
              console.log("reloading because handshake failed for clientId " + window.clientId);
              window.location.reload();
            }
            document.getElementById("popup").ariaHidden = true;
            let mqf = Math.floor(Math.random() * 30 * 1000 + 1);
            setTimeout(() => {
              if (document.title === "XX") {
                return;
              }

              if (window.autoDisconnect) {
                window.txr = Math.floor(Math.random() * 10) * 1000;
                console.log(`============== Planned disconnect: ${window.txr}`);
                if (window.autoDisconnect) {
                  //   window.autoDisconnect = false;
                  window.socket.disconnect();
                  setTimeout(() => {
                    if (document.title === "XX") {
                      return;
                    }

                    window.socket.connect();
                  }, window.txr);
                }
              }
            }, mqf);
            // ===============================
          });
        },
        connect_error: (err) => {
          if (err.message == "timeout") {
            console.log("reloading because connection timed out");
            window.location.reload(); // see https://github.com/zauberzeug/nicegui/issues/198
          }
        },
        try_reconnect: async () => {
          document.getElementById("popup").ariaHidden = false;
          await fetch(window.location.href, { headers: { "NiceGUI-Check": "try_reconnect" } });
          console.log("reloading because reconnect was requested");
          window.location.reload();
        },
        disconnect: () => {
          document.getElementById("popup").ariaHidden = false;
          window.syncing = true;
        },
        update: async (msg) => {
          for (const [id, element] of Object.entries(msg)) {
            if (element === null) {
              delete this.elements[id];
              continue;
            }
            if (element.component || element.libraries) {
              await loadDependencies(element, options.prefix, options.version);
            }
            this.elements[id] = element;
            replaceUndefinedAttributes(this.elements, id);
          }
        },
        run_javascript: (msg) => runJavascript(msg["code"], msg["request_id"]),
        open: (msg) => {
          const url = msg.path.startsWith("/") ? options.prefix + msg.path : msg.path;
          const target = msg.new_tab ? "_blank" : "_self";
          window.open(url, target);
        },
        download: (msg) => download(msg.src, msg.filename, msg.media_type, options.prefix),
        notify: (msg) => Quasar.Notify.create(msg),
        syncronize: (msg) => {
          window.autoDisconnect = true;

          if (msg.retransmit_id == window.retransmitId) {
            // document.getElementById("c5").style.color = "red";

            let msgs = msg.messages.concat(window.syncingQue);
            let red = false;
            let xvo = 0;
            let startTime = null;
            let startCount = null;

            startCount = xvo;
            startTime = performance.now();

            // msg.messages.concat(window.syncingQue).forEach(async (message, i) => {
            var len = msgs.length;
            let i = 0;
            while (i < len) {
              if (document.title === "XX") {
                return;
              }
              xvo++;

              msgs[i][1].history = i;
              if (!processMessageId(msgs[i][0], msgs[i][1])) {
                return;
              }
              messageHandlers[msgs[i][0]](msgs[i][1]);
              //   wrappedHandlers[message[0]](message[1]);
              //   await new Promise((r) => setTimeout(r, 3));
              // }, 0);
              //   if (!getElementById("yui")) {
              //     var elem = document.createElement("div");
              //     elem.id = "yui";
              //     document.body.appendChild(elem);
              //   }
              // });
              i++;
            }
            let now = performance.now();
            let msg_count = xvo - startCount;
            let t = now - startTime;
            // document.getElementById("c5").style.color = "black";

            console.log(`msgs: ${msg_count}`);
            console.log(`msgs/s: ${(msg_count / window.txr) * 1000}`);
            console.log(`time: ${t}`);
            console.log(`/s: ${t / msg_count}`);

            console.log(`ret: ${msg.messages.length}`);
            console.log(`smi: ${window.lastMessageId}`);
            console.log(`syc: ${window.syncingQue.length}`);
            console.log(`xoj: ${msgs.length}`);

            window.syncingQue = [];
            // console.log(`window.syncing: ${window.syncing}`);
            window.syncing = false;
          }
        },
      };
      const socketMessageQueue = [];
      let isProcessingSocketMessage = false;
      let wrappedHandlers = {};
      //   let haveIds = { update: true, run_javascript: true, open: true, download: true, notify: truetry_reconnect: true };
      let noMessageId = { connect: true, connect_error: true, disconnect: true, syncronize: true };
      for (const [event, handler] of Object.entries(messageHandlers)) {
        const queueWrapper = async (...args) => {
          if (args.length > 0 && args[0].hasOwnProperty("message_id")) {
            if (window.syncing && args[0].message_id != window.lastMessageId + 1) {
              // console.log(`syncingQue.push: ${msgId}`, message);
              window.syncingQue.push([event, args[0]]);
              return;
            } else {
              if (!processMessageId(event, args[0])) {
                return;
              }
            }
          }

          let red = false;
          let xvo = 0;
          let startTime = null;
          let startCount = null;

          socketMessageQueue.push(() => handler(...args));
          if (!isProcessingSocketMessage) {
            while (socketMessageQueue.length > 0) {
              xvo++;
              if (!red && socketMessageQueue.length > 3) {
                startCount = xvo;
                startTime = performance.now();
                red = true;
                document.getElementsByClassName("msgzzz")[0].style.color = "red";
                console.log(`^^^^^^^^^^^^^^^^^^^ red: ${0}`);
              } else if (red && socketMessageQueue.length == 1) {
                let now = performance.now();
                let msgs = xvo - startCount - 1;
                let t = now - startTime;
                console.log(`msgs: ${msgs}`);
                console.log(`time: ${t}`);
                console.log(`/s: ${t / msgs}`);
                red = false;
                console.log(`^^^^^^^^^^^^^^^^^^^ black: ${0}`);
                document.getElementsByClassName("msgzzz")[0].style.color = "black";
              }
              const handler = socketMessageQueue.shift();
              isProcessingSocketMessage = true;
              try {
                // console.log(`handler: ${args}`);
                await handler();
                // if (red && performance.now() - startTime > 50) {
                if (xvo % 10 === 0) {
                  await new Promise((r) => setTimeout(r, 100));
                }
              } catch (e) {
                console.error(e);
              }
              isProcessingSocketMessage = false;
            }
          }
        };
        if (!true) {
          const idWrapper = async (...args) => {
            const data = args[0];
            // if (data && data.hasOwnProperty("message_id")) {
            if (document.title === "XX") {
              return;
            }
            if (window.syncing) {
              window.syncingQue.push([event, data]);
              return;
            } else {
              console.log(`: ${data.message_id}`);
              if (data.message_id != window.lastMessageId + 1) {
                console.log(`gap detected: ${data.message_id} -- ${window.lastMessageId}`);
                document.title = "XX";
              }
              window.lastMessageId = data.message_id;
              delete data.message_id;
            }

            // }
            queueWrapper(...args);
          };
          wrappedHandlers[event] = idWrapper;
          window.socket.on(event, idWrapper);
        } else {
          window.socket.on(event, queueWrapper);
          wrappedHandlers[event] = queueWrapper;
        }
      }
    },
  }).use(Quasar, {
    config: options.quasarConfig,
  }));
}
function le(msg) {
  console.log(`@@@@@@@@@@@@@@@@@@@@: ${0}`);
  if ("history" in msg) {
    console.log(`history: ${msg.history}`);
  }
  // console.log(`index: ${msg.iindex}`);
}
