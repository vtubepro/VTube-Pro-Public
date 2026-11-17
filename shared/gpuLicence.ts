// Licence facts for the optional GPU sidecars (docs/GPU_TRACKING.md, THIRD_PARTY_NOTICES.md).
//
// RTMW (OpenMMLab mmpose / RTMPose) is offered to every user, enabled, like the other GPU sidecars: the user clicks
// "Set up GPU tracking", the app downloads the model from OpenMMLab's official URL (sha256-checked), and it runs on
// that user's PC. The code is Apache-2.0; the checkpoint carries no licence of its own and was trained on datasets
// that include research-licensed ones (InterHand2.6M, Human-Art). That is a fact we state, not a block.
//
// Pure (no node:, no DOM): the setup tool, the panel and the capability matrix all show this one sentence.

/** The one factual line shown where RTMW is described (panel, docs, THIRD_PARTY_NOTICES.md say the same). */
export const RTMW_NOTE = 'RTMW-x (OpenMMLab) is downloaded by you from OpenMMLab and runs on your PC; its weights were trained on InterHand2.6M and Human-Art, which are research-licensed datasets. Free software.';

/** The one notice every PC that is not an NVIDIA RTX 50-series gets where RTMW would be (panel, capability row and GPU setup all say
 *  this). RTMW itself has no other condition: no owner switch, no environment variable. */
export const RTMW_NEEDS_RTX50 = "Whole-body tracking (RTMW) needs an NVIDIA RTX 50-series card; MediaPipe's body tracking keeps working.";
