// Sous-ensemble de messages (V3) : `pickMessages(messages, ['orders', 'settings.idle'])` ne garde que
// les sous-arbres demandés, chemin pointé, en conservant l'imbrication. Un chemin absent est ignoré ;
// tests/unit/i18n/namespace-coverage.test.ts vérifie qu'aucun espace de noms déclaré n'est absent
// du fichier de messages.
//
// Deux demandes qui se recouvrent (« a.y » puis « a », ou l'inverse) : toutes deux désignent un
// sous-arbre du MÊME arbre source, donc l'une contient l'autre ; poser le sous-arbre demandé
// à son chemin suffit, la dernière demande la plus large l'emporte sans fusion.
type MessageTree = { [key: string]: string | MessageTree };

function isTree(value: unknown): value is MessageTree {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function pickMessages(messages: MessageTree, namespaces: readonly string[]): MessageTree {
  const picked: MessageTree = {};
  // Du plus large au plus étroit : une demande étroite ne remplace jamais une large déjà posée.
  const ordered = [...namespaces].sort(
    (left, right) => left.split('.').length - right.split('.').length,
  );
  for (const namespace of ordered) {
    const path = namespace.split('.');
    let source: unknown = messages;
    for (const key of path) {
      source = isTree(source) ? source[key] : undefined;
    }
    if (source === undefined) continue;

    let target = picked;
    let covered = false;
    for (const key of path.slice(0, -1)) {
      const next = target[key];
      if (typeof next === 'string') {
        covered = true;
        break;
      }
      if (isTree(next)) {
        target = next;
      } else {
        const created: MessageTree = {};
        target[key] = created;
        target = created;
      }
    }
    if (covered) continue;
    target[path.at(-1) as string] = source as string | MessageTree;
  }
  return picked;
}
