// Vertex shader scaffolding that keeps three.js skinning + morph targets working in custom ShaderMaterials.

export const SKINNED_VERTEX_PARS = /* glsl */ `
#include <common>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
`;

/** Computes `transformed`, `objectNormal`, `transformedNormal`, `mvPosition`, gl_Position. */
export const SKINNED_VERTEX_MAIN = /* glsl */ `
  #include <morphinstance_vertex>
  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
`;
