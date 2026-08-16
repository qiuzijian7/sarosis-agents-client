import { LGraph, LiteGraph } from '@comfyorg/litegraph';
import { parseGuiWorkflow, guiToApi } from '../src/features/workflowEditor/comfyHost/comfyApiAdapter';

const gui = {
  version: 0.4,
  nodes: [
    { id: 1, type: 'CheckpointLoaderSimple', pos: [0,0], inputs: [{ name: 'ckpt_name', type: 'STRING', link: null, widget: { name: 'ckpt_name' } }], widgets_values: ['x.safetensors'], outputs: [{ name: 'MODEL', type: 'MODEL', links: [1] }] },
    { id: 2, type: 'CLIPTextEncode', pos: [200,0], inputs: [{ name: 'clip', type: 'CLIP', link: 1 }], widgets_values: ['a cat'], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [2] }] },
    { id: 3, type: 'KSampler', pos: [400,0], inputs: [{ name: 'positive', type: 'CONDITIONING', link: 2 }], outputs: [{ name: 'LATENT', type: 'LATENT', links: [3] }] },
    { id: 4, type: 'VAEDecode', pos: [600,0], inputs: [{ name: 'samples', type: 'LATENT', link: 3 }], outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [4] }] },
    { id: 5, type: 'SaveImage', pos: [800,0], inputs: [{ name: 'images', type: 'IMAGE', link: 4 }], outputs: [] },
  ],
  links: [[1,1,0,2,0,'CLIP'],[2,2,0,3,1,'CONDITIONING'],[3,3,0,4,0,'LATENT'],[4,4,0,5,0,'IMAGE']],
};

const parsed = parseGuiWorkflow(gui);
console.log('parsed graph node inputs preserved?', parsed.graph.nodes[1]?.inputs !== undefined);
console.log('parsed node0:', JSON.stringify(parsed.graph.nodes[0]));
const g = new LGraph();
g.configure({ ...parsed.graph, id: 'wf', groups: [] });
const ser = g.serialize();
const node4 = ser.nodes.find(n => n.id === 4);
console.log('node4 inputs after import:', JSON.stringify(node4?.inputs));
console.log('node4 has link?', node4?.inputs?.[0]?.link);
const node2 = ser.nodes.find(n => n.id === 2);
console.log('node2 inputs after import:', JSON.stringify(node2?.inputs));
const api = guiToApi(ser);
console.log('api[4].inputs:', JSON.stringify(api['4']?.inputs));
