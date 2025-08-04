interface ChangeLog {
  nodeId: string;
  originalCharacters: string;
}

interface TextNodeInfo {
  nodeId: string;
  characters: string;
}

interface OrganizedTextNodes {
  [frameId: string]: {
    frameName: string;
    textNodes: TextNodeInfo[];
  }
}

interface FrameNodeInfo {
  nodeId: string;
  name: string;
}

let foundNodes: SceneNode[] = [];
let currentIndex: number = -1;
let lastChangeSet: ChangeLog[] = [];

figma.showUI(__html__, { width: 340, height: 480 });

function findTopLevelFrame(node: BaseNode): FrameNode | null {
  let parent = node.parent;
  let highestFrame: FrameNode | null = null;

  while (parent && parent.type !== 'PAGE') {
    if (parent.type === 'FRAME') {
      highestFrame = parent;
    }
    parent = parent.parent;
  }
  
  return highestFrame;
}

function processSelection() {
  const selectedNodes = figma.currentPage.selection;
  
  // --- Lógica para Textos (quase igual a antes) ---
  const selectedTextNodes = selectedNodes.filter(node => node.type === 'TEXT') as TextNode[];
  const organizedTextNodes: OrganizedTextNodes = {};
  if (selectedTextNodes.length > 0) {
    for (const textNode of selectedTextNodes) {
      const topLevelFrame = findTopLevelFrame(textNode);
      if (topLevelFrame) {
        const frameId = topLevelFrame.id;
        const frameName = topLevelFrame.name;
        if (!organizedTextNodes[frameId]) {
          organizedTextNodes[frameId] = { frameName: frameName, textNodes: [] };
        }
        organizedTextNodes[frameId].textNodes.push({ nodeId: textNode.id, characters: textNode.characters });
      }
    }
  }

  // --- NOVA LÓGICA para Frames ---
  const selectedFrameNodes = selectedNodes.filter(node => node.type === 'FRAME') as FrameNode[];
  const frameData: FrameNodeInfo[] = [];
  if (selectedFrameNodes.length > 0) {
    for (const frameNode of selectedFrameNodes) {
      frameData.push({
        nodeId: frameNode.id,
        name: frameNode.name
      });
    }
  }

  // Envia AMBOS os conjuntos de dados para a UI
  figma.ui.postMessage({ 
    type: 'selectionChange', 
    textData: organizedTextNodes, 
    frameData: frameData 
  });
}

processSelection();
figma.on('selectionchange', processSelection);

function navigateAndNotify(newIndex: number, selectNode: boolean = false) {
  currentIndex = newIndex;
  const node = foundNodes[currentIndex];

  if (node && node.type === 'TEXT') {
    // Apenas centraliza a visão, não interfere no foco de edição do usuário
    figma.viewport.scrollAndZoomIntoView([node]);
    
    // A seleção só ocorre se for uma ação explícita (navegar, substituir)
    if (selectNode) {
      figma.currentPage.selection = [node];
    }

    figma.ui.postMessage({
      type: 'navigation-update',
      index: currentIndex,
      count: foundNodes.length,
      nodeText: node.characters
    });
  } else {
    figma.ui.postMessage({ type: 'search-result', count: 0, index: -1 });
  }
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'apply-changes') {
    for (const change of msg.data) {
      const node = await figma.getNodeByIdAsync(change.nodeId);

      if (node && node.type === 'TEXT') {
        await figma.loadFontAsync(node.fontName as FontName);
        node.characters = change.newText;
      }
    }
    figma.notify("Textos atualizados!");
  }

  if (msg.type === 'apply-frame-name-changes') {
    for (const change of msg.data) {
      const node = await figma.getNodeByIdAsync(change.nodeId);
      if (node && node.type === 'FRAME') {
        node.name = change.newName;
      }
    }
    figma.notify("Nomes dos frames atualizados!");
  }

  if (msg.type === 'cancel') {
    figma.closePlugin();
  }

  if (msg.type === 'find-text') {
    const query = msg.query.trim();
    if (query === '') {
      foundNodes = [];
      currentIndex = -1;
    } else {
      // Lógica de busca com case-sensitive
      foundNodes = figma.currentPage.findAll(node => {
        if (node.type !== 'TEXT') return false;
        
        const nodeText = node.characters;
        if (msg.isCaseSensitive) {
          return nodeText.includes(query);
        } else {
          return nodeText.toLowerCase().includes(query.toLowerCase());
        }
      });
      currentIndex = foundNodes.length > 0 ? 0 : -1;
    }

    if (currentIndex !== -1) {
      // Ao buscar, apenas centralizamos, não selecionamos para não roubar o foco.
      navigateAndNotify(currentIndex, false); 
    } else {
      figma.ui.postMessage({ type: 'search-result', count: 0, index: -1 });
    }
  }

  if (msg.type === 'navigate') {
    if (foundNodes.length === 0) return;
    let newIndex = currentIndex;
    if (msg.direction === 'next') {
      newIndex = (currentIndex + 1) % foundNodes.length;
    } else if (msg.direction === 'prev') {
      newIndex = (currentIndex - 1 + foundNodes.length) % foundNodes.length;
    }
    // Ao navegar com botões, nós selecionamos o nó.
    navigateAndNotify(newIndex, true);
  }

  // --- NOVAS LÓGICAS DE REPLACE ---
  if (msg.type === 'replace-single') {
    if (currentIndex === -1 || !foundNodes[currentIndex]) return;

    const node = foundNodes[currentIndex] as TextNode;
    const originalText = node.characters;
    const findRegex = new RegExp(msg.findText, msg.isCaseSensitive ? '' : 'i');

    if (findRegex.test(originalText)) {
      await figma.loadFontAsync(node.fontName as FontName);
      node.characters = originalText.replace(findRegex, msg.replaceText);
      
      // Armazena a alteração para um possível "Desfazer"
      lastChangeSet = [{ nodeId: node.id, originalCharacters: originalText }];
      
      // Notifica a UI do sucesso e envia os dados atualizados
      figma.ui.postMessage({ 
        type: 'replace-success', 
        count: 1,
        // Envia os dados necessários para a UI se atualizar sem outra chamada
        updatedNode: { 
          index: currentIndex, 
          count: foundNodes.length, 
          nodeText: node.characters 
        } 
      });
    }
  }

  if (msg.type === 'replace-all') {
    if (foundNodes.length === 0) return;
    
    const changesToUndo: ChangeLog[] = [];
    const replacePromises = foundNodes.map(async (node) => {
      if (node.type === 'TEXT') {
        const originalText = node.characters;
        // Armazena o estado original ANTES de modificar
        changesToUndo.push({ nodeId: node.id, originalCharacters: originalText });

        const findRegex = new RegExp(msg.findText, msg.isCaseSensitive ? 'g' : 'gi');
        const newText = originalText.replace(findRegex, msg.replaceText);
        await figma.loadFontAsync(node.fontName as FontName);
        node.characters = newText;
      }
    });

    await Promise.all(replacePromises);
    
    // Atualiza o change set global
    lastChangeSet = changesToUndo;
    
    // Limpa o estado da busca
    foundNodes = [];
    currentIndex = -1;

    // Notifica a UI que a substituição em massa foi concluída
    figma.ui.postMessage({ type: 'replace-success', count: lastChangeSet.length, allReplaced: true });
  }

  // --- NOVA LÓGICA DE DESFAZER ---
  if (msg.type === 'undo-last-change') {
    if (lastChangeSet.length === 0) return;

    const undoPromises = lastChangeSet.map(async (change) => {
      const node = await figma.getNodeByIdAsync(change.nodeId);
      if (node && node.type === 'TEXT') {
        await figma.loadFontAsync(node.fontName as FontName);
        node.characters = change.originalCharacters;
      }
    });

    await Promise.all(undoPromises);
    
    figma.notify(`${lastChangeSet.length} ${lastChangeSet.length > 1 ? 'alterações desfeitas' : 'alteração desfeita'}!`);
    
    // Limpa o log de alterações para não poder desfazer duas vezes
    lastChangeSet = [];
    
    // Notifica a UI para que ela possa se limpar
    figma.ui.postMessage({ type: 'undo-complete' });
  }
};