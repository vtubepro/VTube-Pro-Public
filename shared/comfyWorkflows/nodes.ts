// Custom nodes the shareable workflows need, pinned to an exact commit. Everything else is built into ComfyUI
// (background removal included: ComfyUI's own RemoveBackground + LoadBackgroundRemovalModel nodes with BiRefNet, so no
// GPL node and no non-commercial RMBG-2.0). Pure data.
//
// The helper installs a custom node only with `git clone` + `git checkout <commit>` and then checks that HEAD is that
// commit (the commit hash is the integrity check). It never runs pip: a node that needs extra Python packages must list
// them in `pip` and is then NOT auto-installed (the user gets ComfyUI Manager steps instead).

export interface CustomNode {
  id: string;
  name: string;
  /** Folder name under ComfyUI/custom_nodes. */
  folder: string;
  repo: string;
  commit: string;
  commitDate: string;
  licence: string;
  /** Python packages it needs beyond ComfyUI's own (empty = none). */
  pip: string[];
  /** Node classes our workflows use from it (the schema check knows them). */
  classes: string[];
  /** What to search for in ComfyUI Manager. */
  managerSearch: string;
  checked: string;
}

export const CUSTOM_NODES: CustomNode[] = [
  {
    id: 'ipadapter-plus', name: 'ComfyUI_IPAdapter_plus', folder: 'ComfyUI_IPAdapter_plus',
    repo: 'https://github.com/cubiq/ComfyUI_IPAdapter_plus',
    commit: 'a0f451a5113cf9becb0847b92884cb10cbdec0ef', commitDate: '2025-04-14',
    licence: 'GPL-3.0 (the node code; it runs inside your ComfyUI, VTube Pro does not ship it)',
    pip: [],
    classes: ['IPAdapterModelLoader', 'IPAdapterAdvanced'],
    managerSearch: 'ComfyUI_IPAdapter_plus',
    checked: '2026-10-01',
  },
];

export const customNodeById = (id: string) => CUSTOM_NODES.find((n) => n.id === id);
