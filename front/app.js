import { API_URL } from "./config.js";
import { api } from "./api.js";

const $ = (selector, root = document) => root.querySelector(selector);

$("#docs-link").href = API_URL;

const dateFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" });
const formatDate = (iso) => dateFormat.format(new Date(iso));

// Construit un élément sans jamais passer par innerHTML : les données de
// l'API (titres, noms) sont insérées comme du texte.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function button(label, onClick, className = "") {
  return el("button", { type: "button", class: className, onclick: onClick }, label);
}

function toast(message, isError = false) {
  const node = el("p", { class: isError ? "toast error" : "toast" }, message);
  $("#toasts").append(node);
  setTimeout(() => node.remove(), 5000);
}

// Exécute une action déclenchée par un bouton et affiche l'erreur de l'API.
async function run(action) {
  try {
    await action();
  } catch (error) {
    toast(error.message, true);
  }
}

function showFormError(dialog, error) {
  const target = $(".form-error", dialog);
  target.textContent = error ? error.message : "";
  target.hidden = !error;
}

for (const cancel of document.querySelectorAll("[data-cancel]")) {
  cancel.addEventListener("click", () => cancel.closest("dialog").close());
}

// Branche un formulaire de boîte de dialogue sur un appel à l'API.
// L'erreur renvoyée par l'API reste affichée dans la boîte, qui ne se ferme
// qu'en cas de succès.
function bindSubmit(dialog, form, handler) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    showFormError(dialog, null);
    try {
      await handler(new FormData(form));
      dialog.close();
      await refresh();
    } catch (error) {
      showFormError(dialog, error);
    }
  });
}

// --- Onglets ---------------------------------------------------------------

const tabs = ["games", "members"];

function currentTab() {
  const name = location.hash.slice(1);
  return tabs.includes(name) ? name : "games";
}

async function refresh() {
  const tab = currentTab();
  for (const name of tabs) {
    $(`#${name}`).hidden = name !== tab;
    $(`[data-tab="${name}"]`).toggleAttribute("aria-current", name === tab);
  }
  await run(tab === "games" ? loadGames : loadMembers);
}

window.addEventListener("hashchange", refresh);

// --- Jeux ------------------------------------------------------------------

async function loadGames(filters = {}) {
  const games = await api.listGames(filters);
  $("#games-empty").hidden = games.length > 0;
  $("#games-list").replaceChildren(...games.map(gameCard));
}
async function deleteGame(game) {
  const confirmed = confirm(`Voulez-vous vraiment supprimer « ${game.title} » ?`);

  if (!confirmed) return;

  await run(async () => {
    await api.deleteGame(game.id);
    toast(`Le jeu « ${game.title} » a été supprimé.`);
    await loadGames();
  });
}

function gameCard(game) {
  const players =
    game.minPlayers === game.maxPlayers ? `${game.minPlayers}` : `${game.minPlayers} à ${game.maxPlayers}`;
  const status = game.isAvailable
    ? el("span", { class: "badge ok" }, "Disponible")
    : el("span", { class: "badge busy" }, "Emprunté");

  const actions = el("div", { class: "actions" });

  actions.append(button("Modifier", () => openEditGameDialog(game)));
  actions.append(button("Supprimer", () => deleteGame(game)));
  if (game.isAvailable) {
    actions.append(button("Emprunter", () => openBorrowDialog(game), "primary"));
  }
  return el(
    "li",
    { class: "card" },
    el("div", { class: "card-head" }, el("h3", {}, game.title), status),
    el("p", { class: "meta" }, `${players} joueur·ses · ${game.durationMinutes} min`),
    actions,
  );
}

const gameDialog = $("#game-dialog");
const gameForm = $("#game-form");
let editingGame = null;
async function openEditGameDialog(game) {
  editingGame = game;
  gameForm.elements.title.value = game.title;
  gameForm.elements.minPlayers.value = game.minPlayers;
  gameForm.elements.maxPlayers.value = game.maxPlayers;
  gameForm.elements.durationMinutes.value = game.durationMinutes;

  showFormError(gameDialog, null);
  gameDialog.showModal();
}
$("#add-game").addEventListener("click", () => {
  gameForm.reset();
  editingGame = null;
  showFormError(gameDialog, null);
  gameDialog.showModal();
});

bindSubmit(gameDialog, gameForm, (data) => {
  const game = {
    title: data.get("title").trim(),
    minPlayers: Number(data.get("minPlayers")),
    maxPlayers: Number(data.get("maxPlayers")),
    durationMinutes: Number(data.get("durationMinutes")),
  };

  if (editingGame) {
    return api.updateGame(editingGame.id, game);
  }

  return api.createGame(game);
});

// --- Emprunts --------------------------------------------------------------

const borrowDialog = $("#borrow-dialog");
const borrowForm = $("#borrow-form");
let borrowedGame = null;

async function openBorrowDialog(game) {
  await run(async () => {
    const members = await api.listMembers();
    if (members.length === 0) {
      toast("Ajoutez d'abord un·e adhérent·e pour pouvoir emprunter.", true);
      return;
    }
    borrowedGame = game;
    $("#borrow-dialog-title").textContent = `Emprunter « ${game.title} »`;
    $("select", borrowForm).replaceChildren(
      ...members.map((member) => el("option", { value: member.id }, `${member.name} (${member.email})`)),
    );
    showFormError(borrowDialog, null);
    borrowDialog.showModal();
  });
}

bindSubmit(borrowDialog, borrowForm, async (data) => {
  const loan = await api.borrow(borrowedGame.id, data.get("memberID"));
  toast(`« ${borrowedGame.title} » emprunté, à rendre avant le ${formatDate(loan.dueAt)}.`);
});

// --- Adhérent·es -----------------------------------------------------------

async function loadMembers() {
  const members = await api.listMembers();
  $("#members-empty").hidden = members.length > 0;
  $("#members-list").replaceChildren(...members.map(memberRow));
}

async function showMemberLoans(member) {
  await run(async () => {
    const loans = await api.listMemberLoans(member.id);
    const games = await api.listGames();

    const activeLoans = loans.filter((loan) => !loan.returnedAt);

    if (activeLoans.length === 0) {
      toast(`${member.name} n'a aucun emprunt en cours.`);
      return;
    }

    const dialog = el("dialog", { class: "loans-dialog" });

    const content = el(
      "div",
      {},
      el("h2", {}, `Emprunts de ${member.name}`)
    );

    for (const loan of activeLoans) {
      const game = games.find((item) => item.id === loan.gameID);
      const title = game ? game.title : "Jeu inconnu";

      const returnButton = button("Retourner", async () => {
        await run(async () => {
          await api.returnLoan(loan.id);
          dialog.close();
          dialog.remove();

          toast(`« ${title} » a été retourné.`);
          await refresh();
          await showMemberLoans(member);
        });
      }, "primary");

      content.append(
        el(
          "div",
          { class: "row" },
          el(
            "div",
            { class: "row-main" },
            el("strong", {}, title),
            el("p", { class: "meta" }, `À rendre avant le ${formatDate(loan.dueAt)}`)
          ),
          returnButton
        )
      );
    }

    content.append(
      button("Fermer", () => {
        dialog.close();
        dialog.remove();
      })
    );

    dialog.append(content);
    document.body.append(dialog);
    dialog.showModal();
  });
}

async function deleteMember(member) {
  const confirmed = confirm(
    `Voulez-vous vraiment supprimer « ${member.name} » ?`
  );

  if (!confirmed) return;

  await run(async () => {
    await api.deleteMember(member.id);
    toast(`L'adhérent « ${member.name} » a été supprimé.`);
    await loadMembers();
  });
}

function memberRow(member) {
  const actions = el("div", { class: "actions" });
  actions.append(
    button("Modifier", () => openEditMemberDialog(member))
  );
  actions.append(
    button("Supprimer", () => deleteMember(member))
  );
  actions.append(
    button("Mes emprunts", () => showMemberLoans(member))
  );
  return el(
    "li",
    { class: "row" },
    el(
      "div",
      { class: "row-main" },
      el("p", {}, el("strong", {}, member.name)),
      el("p", { class: "meta" }, member.email)
    ),
    actions
  );
}

const memberDialog = $("#member-dialog");
const memberForm = $("#member-form");
let editingMember = null;

function openEditMemberDialog(member) {
  editingMember = member;

  memberForm.elements.name.value = member.name;
  memberForm.elements.email.value = member.email;

  showFormError(memberDialog, null);
  memberDialog.showModal();
}
$("#add-member").addEventListener("click", () => {
  memberForm.reset();
  editingMember = null;
  showFormError(memberDialog, null);
  memberDialog.showModal();
});
bindSubmit(memberDialog, memberForm, (data) => {
  const member = {
    name: data.get("name").trim(),
    email: data.get("email").trim(),
  };

  if (editingMember) {
    return api.updateMember(editingMember.id, member);
  }

  return api.createMember(member);
});

refresh();
$("#apply-filters").addEventListener("click", () => {
  const filters = {
    q: $("#game-search").value.trim(),
    players: $("#filter-players").value,
    maxDuration: $("#filter-duration").value,
    available: $("#filter-availability").value,
  };

  run(() => loadGames(filters));
});

$("#reset-filters").addEventListener("click", () => {
  $("#game-search").value = "";
  $("#filter-players").value = "";
  $("#filter-duration").value = "";
  $("#filter-availability").value = "";

  run(() => loadGames());
});