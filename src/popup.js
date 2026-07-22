// Popup settings panel: toggle features and manage saved project colors.

// Keep this list in sync with the feature modules under src/features/.
var FEATURES = [
  {
    id: "project-colors",
    name: "Project colors",
    description: "Color-code sidebar chats by project, with a picker in the project header.",
    defaultEnabled: true
  }
];

function get(keys) {
  return new Promise(function (r) { chrome.storage.local.get(keys, r); });
}
function set(obj) {
  return new Promise(function (r) { chrome.storage.local.set(obj, r); });
}

function isEnabled(flags, f) {
  return Object.prototype.hasOwnProperty.call(flags, f.id)
    ? !!flags[f.id]
    : f.defaultEnabled !== false;
}

function renderFeatures(flags) {
  var host = document.getElementById("features");
  host.textContent = "";
  FEATURES.forEach(function (f) {
    var row = document.createElement("div");
    row.className = "feature";

    var label = document.createElement("label");
    label.className = "switch";
    var input = document.createElement("input");
    input.type = "checkbox";
    input.checked = isEnabled(flags, f);
    input.addEventListener("change", function () {
      get(["cppFeatures"]).then(function (d) {
        var next = d.cppFeatures || {};
        next[f.id] = input.checked;
        set({ cppFeatures: next });
      });
    });
    var slider = document.createElement("span");
    slider.className = "slider";
    label.appendChild(input);
    label.appendChild(slider);

    var meta = document.createElement("div");
    meta.className = "meta";
    var name = document.createElement("div");
    name.className = "name";
    name.textContent = f.name;
    var desc = document.createElement("div");
    desc.className = "desc";
    desc.textContent = f.description;
    meta.appendChild(name);
    meta.appendChild(desc);

    row.appendChild(meta);
    row.appendChild(label);
    host.appendChild(row);
  });
}

function renderColors(colors) {
  var host = document.getElementById("colors");
  host.textContent = "";
  var ids = Object.keys(colors);
  if (!ids.length) {
    var empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No colors yet. Open a project and pick one.";
    host.appendChild(empty);
    return;
  }
  ids.forEach(function (pid) {
    var row = document.createElement("div");
    row.className = "color-row";

    var dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = colors[pid];

    var code = document.createElement("code");
    code.textContent = pid.slice(0, 8) + "…";
    code.title = pid;

    var del = document.createElement("button");
    del.className = "del";
    del.textContent = "×";
    del.title = "Remove color";
    del.addEventListener("click", function () {
      get(["projectColors"]).then(function (d) {
        var next = d.projectColors || {};
        delete next[pid];
        set({ projectColors: next }).then(function () { renderColors(next); });
      });
    });

    row.appendChild(dot);
    row.appendChild(code);
    row.appendChild(del);
    host.appendChild(row);
  });
}

document.getElementById("clear-colors").addEventListener("click", function () {
  set({ projectColors: {} }).then(function () { renderColors({}); });
});

get(["cppFeatures", "projectColors"]).then(function (d) {
  renderFeatures(d.cppFeatures || {});
  renderColors(d.projectColors || {});
});
