export type Reference = {
  id: string;
  title: string;
  image: string;
  category: "Architecture" | "Roots & canopy" | "Terrain" | "Uploaded";
  reason: string;
  source?: string;
  credit?: string;
  selected: boolean;
  guidance: string;
};
export type Concept = {
  id: string;
  name: string;
  image: string;
  created: string;
};
export type Location = {
  id: string;
  name: string;
  parent: string;
  scenes: string[];
  brief: string;
  requirements: string;
  questions: string;
  approved: boolean;
  deferred: boolean;
  refs: Reference[];
  concepts: Concept[];
  locked?: string;
};
export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  scope: string;
};
export type Workspace = {
  locations: Location[];
  messages: Message[];
  active: string;
};
const refs: Reference[] = [
  {
    id: "root",
    title: "Living root bridge",
    image: "/references/0.jpg",
    category: "Roots & canopy",
    reason:
      "Interwoven roots span an open space. Borrow the branching structure and natural connections for the temple canopy.",
    source:
      "https://commons.wikimedia.org/wiki/File:Living_Root_Bridge,_Mawlynnong.jpg",
    credit: "Sujan Bandyopadhyay · CC BY-SA 4.0",
    selected: false,
    guidance: "",
  },
  {
    id: "temple",
    title: "Timber & stone temple",
    image: "/references/1.jpg",
    category: "Architecture",
    reason:
      "Layered stone walls, carved timber and slate roofs. A starting point for the shrine beneath the tree.",
    source: "https://commons.wikimedia.org/wiki/File:Temple_in_Chitkul.jpg",
    credit: "Marsmx · CC BY-SA 4.0",
    selected: false,
    guidance: "",
  },
  {
    id: "river",
    title: "Baspa river in monsoon",
    image: "/references/2.jpg",
    category: "Terrain",
    reason:
      "A river cuts through green slopes beneath low cloud. Borrow the riverbank relationship and enclosing terrain.",
    source:
      "https://commons.wikimedia.org/wiki/File:River_Baspa_during_Monsoon_in_Chitkul.jpg",
    credit: "Malvikabaru · CC BY-SA 4.0",
    selected: false,
    guidance: "",
  },
  {
    id: "tower",
    title: "Labrang stone & timber",
    image: "/references/3.jpg",
    category: "Architecture",
    reason:
      "Alternating timber and stone establish a strong material rhythm. Use for construction detail rather than overall scale.",
    source: "https://commons.wikimedia.org/wiki/File:Labrang_Fort_1.jpg",
    credit: "Aniketalam · CC BY-SA 4.0",
    selected: false,
    guidance: "",
  },
];
export const initial: Workspace = {
  active: "temple",
  messages: [],
  locations: [
    {
      id: "temple",
      name: "Tree Temple",
      parent: "Devgram",
      scenes: ["03", "07", "12"],
      brief:
        "A small, weathered stone shrine enclosed by the roots of an ancient tree. The canopy makes the interior feel intimate and sheltered. A narrow approach connects the entrance to the riverbank.",
      requirements:
        "Keep the shrine entrance readable.\nLeave space beneath the roots for the central action.\nUse timber, grey stone and slate as the starting material palette.",
      questions: "Interior depth and rear access remain open for blockout.",
      approved: false,
      deferred: false,
      refs,
      concepts: [],
    },
    {
      id: "village",
      name: "Devgram",
      parent: "Village",
      scenes: ["01", "02", "05"],
      brief:
        "A prosperous village with a lived-in centre, winding paths and a temple at its outskirts.",
      requirements: "Maintain a clear route between the village and temple.",
      questions: "Confirm the overall settlement layout during blockout.",
      approved: false,
      deferred: false,
      refs: [],
      concepts: [],
    },
    {
      id: "well",
      name: "Village Well",
      parent: "Devgram",
      scenes: ["04", "08"],
      brief: "A communal stone well set within a small open gathering space.",
      requirements: "Provide enough space for conversation around the well.",
      questions: "Decide on the surrounding buildings.",
      approved: false,
      deferred: false,
      refs: [],
      concepts: [],
    },
    {
      id: "house",
      name: "Prasad’s House",
      parent: "Devgram",
      scenes: ["06", "09"],
      brief:
        "A modest village home with a quiet interior and a threshold facing the lane.",
      requirements: "Keep the entrance and interior circulation clear.",
      questions: "Confirm room connections.",
      approved: false,
      deferred: false,
      refs: [],
      concepts: [],
    },
  ],
};
export async function readWorkspace(): Promise<Workspace | null> {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction("state");
    const r = t.objectStore("state").get("workspace");
    r.onsuccess = () => res(r.result ?? null);
    r.onerror = () => rej(r.error);
    t.oncomplete = () => db.close();
  });
}
export async function saveWorkspace(data: Workspace) {
  const db = await open();
  return new Promise<void>((res, rej) => {
    const t = db.transaction("state", "readwrite");
    t.objectStore("state").put(data, "workspace");
    t.oncomplete = () => {
      db.close();
      res();
    };
    t.onerror = () => {
      db.close();
      rej(t.error);
    };
  });
}
function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open("motionx-location-studio", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("state");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export function uid() {
  return crypto.randomUUID();
}
