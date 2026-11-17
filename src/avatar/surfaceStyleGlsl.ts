// GLSL for the procedural surface styles (src/avatar/surfaceStyles.ts). Built per (kernel, variant, features) so every
// program only carries the code it uses; one program per combination, compiled at avatar load / style change.
//
// Everything is evaluated in the avatar's REST space (the pre-skinning, post-morph vertex position mapped into the
// avatar frame, metres): the pattern is glued to the skin while it deforms, is seam-free (3D noise, or tri-planar 2D
// patterns with sharp blend weights), and has real-world sizes. Relief is a height field (metres) turned into a normal
// by screen-space derivative bump mapping, so it works identically on MeshToon, MeshStandard/Physical and MToon, skinned
// or not, and everything downstream (cel terminator, toon+ rim, the light show's performer light) sees the new normal
// and the new albedo.
//
// Names: functions vtpSf_*, globals vtpSg_*, uniforms uVtpS* (the other engine patches use vtpA / vtpN / vtpL … locals).

export type Kernel = 'fibre' | 'yarn' | 'clay' | 'smooth' | 'paper' | 'metal' | 'glass' | 'stone' | 'scales' | 'keratin' | 'wetskin';

export interface GlslFeatures {
  kernel: Kernel;
  variant: number;
  stitch: boolean;
  shell: boolean;
  uv: boolean;
  wobble: boolean;
  keratinAttr: boolean;
  /** Own cel highlight (hosts without one: MToon, classic toon). */
  spec: boolean;
  /** Length map from vertex colour R (fur shells). */
  furVC: boolean;
}

// ------------------------------------------------------------------ vertex
export const VERT_PARS = (f: GlslFeatures) => /* glsl */ `
uniform mat3 uVtpSM;
uniform vec3 uVtpST3;
uniform float uVtpSU;
uniform float uVtpSTime;
uniform vec4 uVtpS3;
uniform vec4 uVtpS4;
varying vec3 vVtpSP;
varying vec3 vVtpSN;
${f.stitch ? 'attribute vec4 vtpStitch;\nvarying vec4 vVtpSSt;' : ''}
${f.keratinAttr ? 'attribute vec2 vtpKer;\nvarying vec2 vVtpSK;' : ''}
${f.uv ? 'varying vec2 vVtpSUv;' : ''}
${f.shell ? 'uniform float uVtpShellN;\nuniform vec3 uVtpSway;\nvarying float vVtpSShH;' : ''}
`;

/** After <morphnormal_vertex>: the rest (pre-skin) normal. */
export const VERT_REST_N = /* glsl */ `
  vec3 vtpSgRestN = objectNormal;
`;

/** After <morphtarget_vertex>: rest position (+ morphs) → avatar frame; jelly wobble. */
export const VERT_REST_P = (f: GlslFeatures) => /* glsl */ `
  vVtpSP = uVtpSM * transformed + uVtpST3;
  vVtpSN = normalize( uVtpSM * vtpSgRestN );
  ${f.stitch ? 'vVtpSSt = vtpStitch;' : ''}
  ${f.keratinAttr ? 'vVtpSK = vtpKer;' : ''}
  ${f.uv ? 'vVtpSUv = uv;' : ''}
  ${f.wobble ? /* glsl */ `{
    float vtpSw = sin( dot( vVtpSP, vec3( 31.0, 23.0, 17.0 ) ) + uVtpSTime * 4.3 ) * sin( dot( vVtpSP, vec3( -19.0, 29.0, 37.0 ) ) - uVtpSTime * 3.1 );
    transformed += vtpSgRestN * ( vtpSw * uVtpS3.z / max( uVtpSU, 1e-6 ) );
  }` : ''}
`;

/** Before <project_vertex>: shell layers (instanced: gl_InstanceID = layer) pushed out along the skinned normal,
 *  bent by gravity / wind / motion lag (uVtpSway, world space) — tips bend most. */
export const VERT_SHELL = /* glsl */ `
  {
    float vtpSl = ( float( gl_InstanceID ) + 1.0 ) / max( uVtpShellN, 1.0 );
    vVtpSShH = vtpSl;
    float vtpSlen = uVtpS3.x;
    #ifdef VTP_FURVC
      vtpSlen *= clamp( vColor.r, 0.0, 1.0 );
    #endif
    transformed += normalize( objectNormal ) * ( vtpSlen * vtpSl / max( uVtpSU, 1e-6 ) );
    transformed += inverse( mat3( modelMatrix ) ) * ( uVtpSway * ( vtpSlen * vtpSl * vtpSl ) );
  }
`;

// ------------------------------------------------------------------ fragment: shared helpers
const FRAG_COMMON = (f: GlslFeatures) => /* glsl */ `
uniform vec4 uVtpS0;      // x size (m)  y relief  z variation  w fuzz
uniform vec4 uVtpS1;      // x iridescence  y translucency  z wear  w boil
uniform vec4 uVtpS2;      // x gloss  y stitch half-width (m)  z sheen tightness  w belly
uniform vec4 uVtpS3;      // x fur length (m)  y strand spacing (m)  z wobble (m)  w stitch pitch (m)
uniform vec4 uVtpS4;      // x fine-region amount  y density  z crackle  w unused
uniform vec3 uVtpSC2, uVtpSCS, uVtpSSheen;
uniform vec4 uVtpSTint;   // rgb (linear), a = amount
uniform float uVtpSTintRef, uVtpSQ, uVtpSTime, uVtpSH, uVtpSBM, uVtpSBN;
varying vec3 vVtpSP;
varying vec3 vVtpSN;
${f.stitch ? 'varying vec4 vVtpSSt;' : ''}
${f.keratinAttr ? 'varying vec2 vVtpSK;' : ''}
${f.uv ? 'varying vec2 vVtpSUv;' : ''}
${f.shell ? 'varying float vVtpSShH;\nuniform float uVtpShellN;\nuniform vec4 uVtpSFace[3];' : ''}
float vtpSgH = 0.0;          // relief height (m)
vec3 vtpSgAlb0 = vec3( 1.0 ); // albedo before the style (MToon shade ratio)
float vtpSgId = 0.0;         // cell / scale id 0..1
float vtpSgEdge = 1.0;       // 0 at a cell edge .. 1 in the middle
float vtpSgSpark = 0.0;      // glitter / wet sparkle weight
float vtpSgMetal = 0.0;      // exposed metal (wear) 0..1
float vtpSgNap = 0.5;        // plush: crushed-nap patch (sheen strength)
float vtpSgLumK = 1.0;
float vtpSf_lum( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
float vtpSf_h13( vec3 p3 ) { p3 = fract( p3 * 0.1031 ); p3 += dot( p3, p3.zyx + 31.32 ); return fract( ( p3.x + p3.y ) * p3.z ); }
vec3 vtpSf_h33( vec3 p3 ) { p3 = fract( p3 * vec3( 0.1031, 0.1030, 0.0973 ) ); p3 += dot( p3, p3.yxz + 33.33 ); return fract( ( p3.xxy + p3.yxx ) * p3.zyx ); }
float vtpSf_h12( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
vec2 vtpSf_h22( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.xx + p3.yz ) * p3.zy ); }
// gradient noise 0..1 (quintic fade: no lattice blockiness)
float vtpSf_n3( vec3 p ) {
  vec3 i = floor( p ); vec3 f = fract( p );
  vec3 u = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
  #define VTP_G( o ) dot( vtpSf_h33( i + o ) * 2.0 - 1.0, f - o )
  float n = mix( mix( mix( VTP_G( vec3( 0.0, 0.0, 0.0 ) ), VTP_G( vec3( 1.0, 0.0, 0.0 ) ), u.x ), mix( VTP_G( vec3( 0.0, 1.0, 0.0 ) ), VTP_G( vec3( 1.0, 1.0, 0.0 ) ), u.x ), u.y ),
                 mix( mix( VTP_G( vec3( 0.0, 0.0, 1.0 ) ), VTP_G( vec3( 1.0, 0.0, 1.0 ) ), u.x ), mix( VTP_G( vec3( 0.0, 1.0, 1.0 ) ), VTP_G( vec3( 1.0, 1.0, 1.0 ) ), u.x ), u.y ), u.z );
  #undef VTP_G
  return clamp( 0.5 + n * 0.9, 0.0, 1.0 );
}
float vtpSf_fbm( vec3 p, float oct ) {
  float s = 0.0, a = 0.5, t = 0.0;
  for ( int i = 0; i < 5; i ++ ) { if ( float( i ) >= oct ) break; s += a * vtpSf_n3( p ); t += a; p = mat3( 0.0, 0.8, 0.6, -0.8, 0.36, -0.48, -0.6, -0.48, 0.64 ) * p * 2.03 + vec3( 17.1, 5.3, 11.7 ); a *= 0.5; }
  return s / max( t, 1e-4 );
}
/** 1 while a feature of size s is ≥ ~2 px, fading to 0 when it would alias. */
float vtpSf_aa( float s, float px ) { return 1.0 - smoothstep( 0.35, 0.9, px / max( s, 1e-6 ) ); }
vec3 vtpSf_voro( vec2 p ) {
  vec2 i = floor( p ), f = fract( p ); float d1 = 8.0, d2 = 8.0; vec2 id = vec2( 0.0 );
  for ( int y = -1; y <= 1; y ++ ) for ( int x = -1; x <= 1; x ++ ) {
    vec2 g = vec2( float( x ), float( y ) ); vec2 r = g + vtpSf_h22( i + g ) - f; float d = dot( r, r );
    if ( d < d1 ) { d2 = d1; d1 = d; id = i + g; } else if ( d < d2 ) d2 = d;
  }
  d1 = sqrt( d1 ); d2 = sqrt( d2 );
  return vec3( d1, d2 - d1, vtpSf_h12( id ) );
}
vec3 vtpSf_key() {
  vec3 L = normalize( vec3( 0.3, 0.6, 0.75 ) ); float best = -1.0;
  #if NUM_DIR_LIGHTS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
    {
      float w = dot( directionalLights[ i ].color, vec3( 0.2126, 0.7152, 0.0722 ) );
      if ( w > best ) { best = w; L = directionalLights[ i ].direction; }
    }
  }
  #pragma unroll_loop_end
  #endif
  return L;
}
/** Derivative bump (Mikkelsen): height h (metres) → perturbed view-space normal. */
vec3 vtpSf_bump( vec3 N, float h ) {
  vec3 sp = -vViewPosition;
  vec3 dx = dFdx( sp ), dy = dFdy( sp );
  vec3 r1 = cross( dy, N ), r2 = cross( N, dx );
  float det = dot( dx, r1 );
  vec2 dh = vec2( dFdx( h ), dFdy( h ) );
  vec3 g = sign( det ) * ( dh.x * r1 + dh.y * r2 );
  // never tilt more than ~50 degrees (steps in the height field would flip normals → black specks)
  float gl = length( g ), lim = abs( det ) * 1.2;
  if ( gl > lim ) g *= lim / gl;
  vec3 n = abs( det ) * N - g;
  return dot( n, n ) > 1e-20 ? normalize( n ) : N;
}
`;

// tri-planar sampler for a 2D pattern vtpSf_pat(q, axis) → vec4 (height, edge, id, extra); sharp weights so most
// pixels evaluate ONE projection (two in narrow transition bands)
const TRI = /* glsl */ `
vec4 vtpSf_tri( vec3 P, vec3 N, float s ) {
  vec3 w = pow( abs( N ), vec3( 8.0 ) ); w /= max( w.x + w.y + w.z, 1e-6 );
  vec4 r = vec4( 0.0 ); float t = 0.0;
  if ( w.x > 0.03 ) { r += w.x * vtpSf_pat( vec2( P.z * sign( N.x ), P.y ) / s, 0.0 ); t += w.x; }
  if ( w.z > 0.03 ) { r += w.z * vtpSf_pat( vec2( -P.x * sign( N.z ), P.y ) / s, 2.0 ); t += w.z; }
  if ( w.y > 0.03 ) { r += w.y * vtpSf_pat( vec2( P.x, P.z ) / s, 1.0 ); t += w.y; }
  return r / max( t, 1e-4 );
}
vec4 vtpSf_map( vec3 P, vec3 N, float s ) {
  #ifdef VTP_SUV
    return vtpSf_pat( vVtpSUv * uVtpS4.w * uVtpS0.x / s, 0.0 );
  #else
    return vtpSf_tri( P, N, s );
  #endif
}
`;

// ------------------------------------------------------------------ 2D patterns
const PAT_KNIT = (variant: number) => /* glsl */ `
// knit: q.x across wales, q.y along courses (1 = one stitch). ${variant === 3 ? 'garter' : variant === 2 ? '2x2 rib' : variant === 1 ? '1x1 rib' : 'stockinette'}
vec4 vtpSf_pat( vec2 q, float ax ) {
  q.y /= 0.8;
  float col = floor( q.x );
  float wx = fract( q.x ) - 0.5;
  float lx = abs( wx ) * 2.0;
  float vy = q.y + lx * 0.55;
  float ly = fract( vy ) - 0.5;
  float d = length( vec2( ( lx - 0.52 ) * 1.8, ly * 1.2 ) );
  float h = 1.0 - smoothstep( 0.22, 0.62, d );
  h *= 0.8 + 0.2 * ( 0.5 + 0.5 * sin( ( vy * 2.0 + lx * 1.3 ) * 9.42 ) );   // ply twist
  float purl = ${variant === 1 ? 'mod( col, 2.0 )' : variant === 2 ? 'step( 2.0, mod( col, 4.0 ) )' : variant === 3 ? 'mod( floor( q.y ), 2.0 )' : '0.0'};
  if ( purl > 0.5 ) {
    float by = fract( q.y ) - 0.5;
    float bar = 1.0 - smoothstep( 0.08, 0.42, abs( by ) );
    h = bar * ( 0.8 + 0.2 * sin( q.x * 12.566 ) ) * ${variant === 3 ? '0.85' : '0.6'};
  }
  return vec4( h, 1.0 - d, vtpSf_h12( vec2( col, floor( vy ) ) ), purl );
}
`;
const PAT_CROCHET = /* glsl */ `
// single crochet: staggered posts + a chain bar on top, holes between rows
vec4 vtpSf_pat( vec2 q, float ax ) {
  float row = floor( q.y );
  vec2 c = vec2( q.x + 0.5 * mod( row, 2.0 ), q.y );
  vec2 f = fract( c ) - 0.5; vec2 id = floor( c );
  float post = length( vec2( f.x * 2.0, max( abs( f.y + 0.05 ) - 0.16, 0.0 ) * 1.7 ) );
  float h = 1.0 - smoothstep( 0.25, 0.52, post );
  float bar = length( vec2( max( abs( f.x ) - 0.18, 0.0 ) * 1.6, ( f.y - 0.37 ) * 3.2 ) );
  h = max( h, ( 1.0 - smoothstep( 0.22, 0.5, bar ) ) * 0.85 );
  h *= 0.8 + 0.2 * ( 0.5 + 0.5 * sin( ( f.y * 3.0 + f.x * 1.5 ) * 6.2831 ) );
  return vec4( h, h, vtpSf_h12( id ), 0.0 );
}
`;
const PAT_VORO = /* glsl */ `
vec4 vtpSf_pat( vec2 q, float ax ) { vec3 v = vtpSf_voro( q ); return vec4( v.x, v.y, v.z, 0.0 ); }
`;

/** Scale patterns. variant: 0 hex, 1 overlap (lizard), 2 cycloid (fish), 3 keeled (dragon), 4 diamond (snake), 5 scutes. */
const PAT_SCALES = (variant: number) => {
  if (variant === 0) return /* glsl */ `
vec4 vtpSf_scale( vec2 q ) {
  const vec2 s = vec2( 1.0, 1.7320508 );
  vec4 hc = floor( vec4( q, q - vec2( 0.5, 1.0 ) ) / s.xyxy ) + 0.5;
  vec4 hh = vec4( q - hc.xy * s, q - ( hc.zw + 0.5 ) * s );
  vec4 c = dot( hh.xy, hh.xy ) < dot( hh.zw, hh.zw ) ? vec4( hh.xy, hc.xy ) : vec4( hh.zw, hc.zw + 0.5 );
  vec2 a = abs( c.xy );
  float d = max( dot( a, vec2( 0.5, 0.8660254 ) ), a.x );
  float e = clamp( 1.0 - d * 2.0, 0.0, 1.0 );
  float h = smoothstep( 0.0, 0.3, e ) * ( 0.7 + 0.3 * e );
  return vec4( h, e, vtpSf_h12( c.zw ), 0.0 );
}
`;
  const P = variant === 2 ? { rowH: 0.42, R: 0.72, el: 0.92 } : variant === 3 ? { rowH: 0.58, R: 0.68, el: 0.82 } : variant === 4 ? { rowH: 0.5, R: 0.64, el: 1.0 } : { rowH: 0.54, R: 0.63, el: 1.0 };
  const f = (x: number) => x.toFixed(3);
  return /* glsl */ `
// imbricate (overlapping) scales pointing down (−v): rows from the top; the first scale covering q is on top
vec4 vtpSf_scale( vec2 q ) {
  const float rowH = ${f(P.rowH)}, R = ${f(P.R)};
  float r0 = floor( q.y / rowH );
  vec4 res = vec4( 0.0, 0.0, 0.5, 0.0 );
  for ( int k = 2; k >= -1; k -- ) {
    float row = r0 + float( k );
    float off = mod( row, 2.0 ) * 0.5;
    float cx = floor( q.x - off + 0.5 ) + off;
    float bd = 9.0; vec2 bl = vec2( 0.0 ); vec2 bc = vec2( 0.0 );
    for ( int j = -1; j <= 1; j ++ ) {
      vec2 c = vec2( cx + float( j ), row * rowH );
      vec2 l = ( q - c - ( vtpSf_h22( c * 7.13 + 0.5 ) - 0.5 ) * 0.1 ) / R;
      ${variant === 4 ? 'float d = abs( l.x ) * 1.08 + abs( l.y ) * 0.82;' : `float d = length( l * vec2( 1.0, ${f(P.el)} ) );`}
      if ( d < bd ) { bd = d; bl = l; bc = c; }
    }
    if ( bd < 1.0 ) {
      float free = clamp( 0.5 - 0.5 * bl.y, 0.0, 1.0 );        // 1 at the free (lower) edge
      float h = ( 0.3 + 0.7 * free ) * smoothstep( 1.0, 0.86, bd ) * ( 1.0 - 0.25 * bl.x * bl.x );
      float keel = ${variant === 3 || variant === 4 ? '( 1.0 - smoothstep( 0.0, 0.22, abs( bl.x ) ) ) * smoothstep( -0.9, 0.2, -bl.y )' : '0.0'};
      h += keel * 0.35;
      res = vec4( h, 1.0 - bd, vtpSf_h12( bc ), keel );
      break;
    }
  }
  return res;
}
`;
};
const PAT_SCUTE = /* glsl */ `
// belly plates: wide bands, free edge at the bottom of each plate, a faint split at the sides
vec4 vtpSf_scute( vec2 q ) {
  float f = fract( q.y );
  float h = ( 0.35 + 0.65 * ( 1.0 - f ) ) * smoothstep( 0.0, 0.07, f );
  float side = smoothstep( 0.55, 0.62, abs( fract( q.x ) - 0.5 ) * 2.0 ) * 0.0;
  return vec4( h * ( 1.0 - side ), min( f * 6.0, 1.0 ), vtpSf_h12( vec2( floor( q.y ), 3.1 ) ), 0.0 );
}
`;

// ------------------------------------------------------------------ fragment: kernels (surface stage)
function kernelSurface(f: GlslFeatures): string {
  const v = f.variant;
  switch (f.kernel) {
    case 'fibre': {
      const k = v === 0 ? 'vec3( 1.0 )' : v === 1 ? 'vec3( 1.0, 0.35, 1.0 )' : v === 2 ? 'vec3( 1.0, 0.6, 1.0 )' : 'vec3( 1.0, 0.16, 1.0 )';
      return /* glsl */ `
    float fade = vtpSf_aa( sz, px );
    float fib = vtpSf_fbm( P * ${k} / sz, 2.0 + Q );
    float mott = vtpSf_n3( P / ( sz * 12.0 ) + 3.7 );
    ${v === 0 ? 'float pill = pow( smoothstep( 0.6, 0.95, vtpSf_n3( P / ( sz * 2.6 ) + 11.0 ) ), 2.0 ) * vtpSf_aa( sz * 2.0, px );' : 'float pill = 0.0;'}
    vtpSgH += ( ( fib - 0.5 ) * fade * 0.35 + pill * 0.35 ) * sz;
    alb *= mix( 1.0 - 0.45 * uVtpS0.z, 1.0 + 0.3 * uVtpS0.z, mott ) * mix( 1.0, mix( 0.8, 1.08, fib ), fade );
    alb *= 1.0 + pill * 0.1;
    ${v === 2 ? 'vtpSgNap = vtpSf_n3( P / ( sz * 22.0 ) + 9.0 );' : ''}
    ${v === 3 ? 'alb *= mix( 0.86, 1.04, vtpSf_n3( P * vec3( 1.0, 0.2, 1.0 ) / ( sz * 5.0 ) ) );   // clumps' : ''}`;
    }
    case 'yarn':
      return /* glsl */ `
    vec4 kn = vtpSf_map( P, N, sz );
    float fade = vtpSf_aa( sz * 0.3, px );
    kn.x = mix( 0.55, kn.x, fade );
    float fz = vtpSf_fbm( P / ( sz * 0.14 ), 1.0 + Q );
    vtpSgH += ( kn.x * 0.3 + ( fz - 0.5 ) * 0.05 * fade ) * sz;
    alb *= mix( 0.5, 1.0, smoothstep( 0.0, 0.55, kn.x ) );
    alb *= 1.0 + ( kn.z - 0.5 ) * uVtpS0.z * 0.35;
    alb *= mix( 0.92, 1.05, fz );
    vtpSgId = kn.z;`;
    case 'clay':
      return /* glsl */ `
    float lump = vtpSf_fbm( P / ( sz * 4.0 ), 2.0 + Q );
    float fine = vtpSf_n3( P / ( sz * 0.3 ) );
    // thumb prints: one jittered print per cell (pressed at random spots, ridged rings)
    vec3 cq = P / ( sz * 3.0 ); vec3 ci = floor( cq ); vec3 rr = vtpSf_h33( ci );
    vec3 cp = ( fract( cq ) - ( 0.3 + 0.4 * rr ) ) * sz * 3.0;
    cp -= N * dot( cp, N );
    float pr = length( cp );
    float ridge = 0.5 + 0.5 * sin( pr / ( sz * 0.09 ) * 6.2831 + rr.y * 6.2831 + 3.0 * vtpSf_n3( P / ( sz * 0.5 ) ) );
    float pm = step( 0.55, rr.x ) * ( 1.0 - smoothstep( sz * 0.3, sz * 0.8, pr ) ) * vtpSf_aa( sz * 0.18, px );
    vtpSgH += ( ( lump - 0.5 ) * 0.32 + ( fine - 0.5 ) * 0.03 + ridge * pm * 0.02 - pm * 0.05 ) * sz;
    alb *= mix( 1.0 - 0.35 * uVtpS0.z, 1.0 + 0.2 * uVtpS0.z, lump ) * ( 1.0 - pm * ridge * 0.05 );`;
    case 'smooth':
      if (v === 3) return /* glsl */ `
    vec4 cr = vtpSf_map( P, N, sz * 6.0 );
    float line = ( 1.0 - smoothstep( 0.0, 0.055, cr.y ) ) * vtpSf_aa( sz * 0.3, px ) * uVtpS4.z;
    alb = mix( alb, alb * uVtpSC2, line * 0.75 );
    vtpSgH -= line * sz * 0.02;
    alb *= 1.0 + ( vtpSf_n3( P / ( sz * 20.0 ) ) - 0.5 ) * uVtpS0.z * 0.12;`;
      return /* glsl */ `
    float n = vtpSf_n3( P / ( sz * ${v === 2 ? '0.5' : '0.8'} ) );
    vtpSgH += ( n - 0.5 ) * sz * ${v === 2 ? '0.05' : v === 1 ? '0.012' : '0.008'} * vtpSf_aa( sz, px );
    alb *= 1.0 + ( vtpSf_n3( P / ( sz * 30.0 ) + 2.0 ) - 0.5 ) * uVtpS0.z * ${v === 1 ? '0.35' : '0.2'};
    ${v === 2 ? 'alb *= mix( 0.9, 1.04, n );' : ''}`;
    case 'paper':
      return /* glsl */ `
    float pulp = vtpSf_fbm( P / ( sz * 0.6 ), 2.0 + Q );
    float fa = vtpSf_n3( P * vec3( 1.0, 0.12, 1.0 ) / ( sz * 0.8 ) ), fb = vtpSf_n3( P * vec3( 0.12, 1.0, 1.0 ) / ( sz * 0.8 ) + 7.0 );
    float fibres = max( smoothstep( 0.78, 0.84, fa ), smoothstep( 0.78, 0.84, fb ) ) * vtpSf_aa( sz * 0.3, px );
    // folds: one crease plane per big cell
    vec3 fc = floor( P / ( sz * 45.0 ) ); vec3 fr = vtpSf_h33( fc ) - 0.5;
    float fd = abs( dot( P - ( fc + 0.5 ) * sz * 45.0, normalize( fr + 1e-3 ) ) );
    float crease = ( 1.0 - smoothstep( 0.0, sz * 0.5, fd ) ) * step( 0.1, abs( fr.x ) );
    vtpSgH += ( ( pulp - 0.5 ) * 0.1 + fibres * 0.04 - crease * 0.15 ) * sz;
    alb *= mix( 0.94, 1.03, pulp ) * ( 1.0 - fibres * 0.05 ) * ( 1.0 - crease * 0.12 );
    ${v === 1 ? /* glsl */ `
    float flute = 0.5 + 0.5 * cos( P.y / ( sz * 1.4 ) * 6.2831 );
    vtpSgH += flute * sz * 0.1 * vtpSf_aa( sz * 1.4, px );
    float spk = step( 0.94, vtpSf_h13( floor( P / ( sz * 0.3 ) ) ) ) * vtpSf_aa( sz * 0.3, px );
    alb = mix( alb, alb * uVtpSC2 * 1.6, spk * 0.6 );` : ''}`;
    case 'metal':
      if (v === 0) return /* glsl */ `
    float st = vtpSf_n3( P * vec3( 1.0, 0.012, 1.0 ) / ( sz * 0.3 ) );
    float st2 = vtpSf_n3( P * vec3( 1.0, 0.02, 1.0 ) / ( sz * 1.5 ) + 4.0 );
    float fade = vtpSf_aa( sz * 0.3, px );
    vtpSgH += ( st - 0.5 ) * sz * 0.02 * fade;
    alb *= mix( 1.0, mix( 0.9, 1.08, st * 0.6 + st2 * 0.4 ), max( fade, 0.4 ) );
    vtpSgSpark = 0.3;`;
      return /* glsl */ `
    float wearN = vtpSf_fbm( P / ( sz * 2.5 ), 3.0 );
    float edge = 0.0;
    #ifndef FLAT_SHADED
    {
      vec3 vn = normalize( vNormal );
      float curv = length( fwidth( vn ) ) / max( length( fwidth( vViewPosition ) ), 1e-6 );   // 1/m
      edge = smoothstep( 18.0, 70.0, curv );
    }
    #endif
    float chip = smoothstep( 0.62, 0.7, wearN * 0.75 + edge * 0.55 + ( vtpSf_n3( P / ( sz * 0.6 ) ) - 0.5 ) * 0.2 - ( 1.0 - uVtpS1.z ) * 0.55 );
    alb = mix( alb, uVtpSC2 * mix( 0.85, 1.1, vtpSf_n3( P * vec3( 1.0, 0.02, 1.0 ) / ( sz * 0.2 ) ) ), chip );
    alb *= mix( 0.97, 1.02, wearN );
    vtpSgMetal = chip;
    vtpSgH -= chip * sz * 0.03;`;
    case 'glass':
      if (v === 1) return /* glsl */ `
    vec3 Pr = mat3( 0.8, 0.36, -0.48, -0.6, 0.48, -0.64, 0.0, 0.8, 0.6 ) * P;
    vec3 cc = floor( Pr / sz ); vec3 cr3 = vtpSf_h33( cc ) - 0.5;
    vtpSgH += dot( Pr - ( cc + 0.5 ) * sz, cr3 ) * 0.6;           // one flat tilted facet per cell
    vtpSgId = vtpSf_h13( cc );
    alb *= 0.82 + 0.36 * vtpSgId * uVtpS0.z + ( 1.0 - uVtpS0.z ) * 0.18;
    vtpSgSpark = 1.0;
    ${GLASS_ALPHA}`;
      if (v === 2) return /* glsl */ `
    float sw = vtpSf_n3( P / ( sz * 3.0 ) + vec3( 0.0, uVtpSTime * 0.12, 0.0 ) );
    alb *= mix( 0.82, 1.15, sw );
    vec3 bq = P / ( sz * 1.6 ); vec3 bi = floor( bq ); vec3 br = vtpSf_h33( bi );
    float bd = length( fract( bq ) - ( 0.3 + 0.4 * br ) ); float brad = 0.07 + 0.1 * br.z;
    float bub = step( 0.62, br.x ) * ( 1.0 - smoothstep( brad * 0.75, brad, bd ) ) * smoothstep( brad * 0.35, brad * 0.85, bd );
    alb += bub * 0.22;
    vtpSgH += bub * sz * 0.02;
    vtpSgSpark = 0.5;
    ${GLASS_ALPHA}`;
      return /* glsl */ `
    if ( uVtpSTint.a <= 0.0 ) alb = mix( alb, vec3( 0.82, 0.9, 0.94 ), 0.65 );   // clear glass: a pale version of the colours
    vtpSgSpark = 0.4;
    ${GLASS_ALPHA}`;
    case 'stone':
      return /* glsl */ `
    float l = vtpSf_fbm( P / ( sz * 6.0 ), 3.0 + Q );
    vec4 vv = vtpSf_map( P, N, sz * 8.0 );
    float crack = ( 1.0 - smoothstep( 0.0, 0.045, vv.y ) ) * vtpSf_aa( sz * 0.3, px );
    float spk = step( 0.9, vtpSf_h13( floor( P / ( sz * 0.35 ) ) ) ) * vtpSf_aa( sz * 0.35, px );
    vtpSgH += ( ( l - 0.5 ) * 0.7 - crack * 0.35 ) * sz;
    alb = mix( alb, vec3( vtpSf_lum( alb ) ) * vec3( 1.02, 1.0, 0.96 ), uVtpSTint.a > 0.0 ? 0.0 : 0.65 );   // stone greys the model's colours (unless re-coloured)
    alb *= mix( 0.76, 1.1, l ) * ( 1.0 - 0.22 * spk );
    alb = mix( alb, uVtpSC2, crack * 0.85 );
    alb *= 1.0 + ( vv.z - 0.5 ) * uVtpS0.z * 0.4;
    vtpSgId = vv.z;`;
    case 'scales':
      return /* glsl */ `
    vec4 sc;
    ${v === 5 ? 'sc = vtpSf_scute( vec2( P.x / ( sz * 4.0 ), P.y / sz ) );' : /* glsl */ `
    {
      float fine = 0.0;
      {
        float yy = P.y / max( uVtpSH, 0.1 ), xx = abs( P.x ) / max( uVtpSH, 0.1 );
        fine = clamp( max( max( smoothstep( 0.8, 0.88, yy ), smoothstep( 0.2, 0.3, xx ) ), 1.0 - smoothstep( 0.05, 0.11, yy ) ), 0.0, 1.0 ) * uVtpS4.x;
      }
      sc = fine < 0.98 ? vtpSf_map( P, N, sz ) : vec4( 0.0 );
      if ( fine > 0.02 ) sc = mix( sc, vtpSf_map( P, N, sz * 0.55 ), fine );
      float belly = uVtpS2.w * vtpSf_belly( P, N );
      if ( belly > 0.0 ) {
        if ( belly > 0.01 ) {
          vec4 bs = vtpSf_scute( vec2( P.x / ( sz * 5.0 ), P.y / ( sz * 1.3 ) ) );
          float bm = smoothstep( 0.25, 0.65, belly );
          sc = mix( sc, bs, bm );
          alb = mix( alb, uVtpSC2 * mix( 0.92, 1.06, bs.z ), bm * 0.92 );
        }
      }
    }`}
    float fade = vtpSf_aa( sz * 0.25, px );
    sc = mix( vec4( 0.6, 0.5, sc.z, 0.0 ), sc, fade );
    vtpSgH += sc.x * sz * 0.14;
    alb *= 1.0 + uVtpS0.z * ( sc.z - 0.5 ) * 0.7;
    alb *= mix( 0.5, 1.0, smoothstep( 0.05, 0.6, sc.x ) );               // tucked-under ends sit in shadow
    alb = mix( alb, alb * 1.35 + 0.008, ( 1.0 - smoothstep( 0.0, 0.12, sc.y ) ) * 0.5 * fade );   // bright free edge
    vtpSgId = sc.z; vtpSgEdge = sc.y;
    vtpSgSpark = 0.35;`;
    case 'keratin':
      return /* glsl */ `
    ${f.keratinAttr ? 'float t = clamp( vVtpSK.x, 0.0, 1.0 ); float along = vVtpSK.x * vVtpSK.y;' : 'float t = clamp( P.y / max( uVtpSH, 0.1 ), 0.0, 1.0 ); float along = P.y;'}
    float rings = 0.5 + 0.5 * sin( along / sz * 6.2831 + vtpSf_n3( P / ( sz * 3.0 ) ) * 3.0 );
    float streak = vtpSf_n3( P / ( sz * 0.35 ) + vec3( 0.0, along / ( sz * 4.0 ), 0.0 ) );
    float fade = vtpSf_aa( sz * 0.5, px );
    vtpSgH += ( rings * 0.3 * ( 1.0 - t * 0.7 ) + streak * 0.08 ) * sz * fade;
    alb = mix( alb, uVtpSC2, smoothstep( 0.35, 1.0, t ) * 0.85 );
    alb *= mix( 0.84, 1.05, streak ) * mix( 0.9, 1.0, rings * fade + ( 1.0 - fade ) * 0.5 );`;
    case 'wetskin':
      return /* glsl */ `
    vec3 cq = P / ( sz * 7.0 ); vec3 ci = floor( cq ); vec3 rr = vtpSf_h33( ci );
    float rad = 0.16 + 0.16 * rr.z;
    float sd = length( fract( cq ) - ( 0.32 + 0.36 * rr ) ) + ( vtpSf_n3( P / ( sz * 1.6 ) ) - 0.5 ) * 0.14;
    float spot = step( 0.5, rr.x ) * ( 1.0 - smoothstep( rad * 0.7, rad, sd ) );
    float bel = uVtpS2.w * vtpSf_belly( P, N );
    spot *= 1.0 - bel;
    alb = mix( alb, mix( alb * 0.5, uVtpSC2, 0.55 ) * mix( 0.9, 1.1, rr.y ), spot * 0.8 );
    alb *= 1.0 + bel * 0.2;
    float wart = pow( vtpSf_n3( P / ( sz * 0.55 ) ), 3.0 ) * vtpSf_aa( sz * 0.5, px );
    vtpSgH += ( wart * 0.14 + spot * 0.03 ) * sz;
    alb *= 1.0 + ( vtpSf_n3( P / ( sz * 8.0 ) ) - 0.5 ) * uVtpS0.z * 0.4;
    vtpSgSpark = 1.0;`;
  }
}

const GLASS_ALPHA = /* glsl */ `
    #ifndef FLAT_SHADED
    { float g = abs( dot( normalize( vNormal ), normalize( vViewPosition ) ) ); dc.a = mix( dc.a, 1.0, pow( 1.0 - g, 2.5 ) * 0.85 ); }
    #endif`;

const STITCH = /* glsl */ `
  {
    float w = uVtpS2.y;
    float dist = vVtpSSt.x;
    if ( dist < w * 1.6 ) {
      vec3 T = normalize( vVtpSSt.yzw + 1e-6 );
      float s = dot( P, T ) / max( uVtpS3.w, 1e-4 );
      float seg = fract( s + dist / max( w, 1e-5 ) * 0.3 );
      float dash = smoothstep( 0.06, 0.14, seg ) * ( 1.0 - smoothstep( 0.5, 0.58, seg ) );
      float across = 1.0 - smoothstep( w * 0.7, w, dist );
      float fadeS = vtpSf_aa( uVtpS3.w * 0.5, px );
      float thread = dash * across * fadeS;
      float groove = ( 1.0 - smoothstep( 0.0, w * 0.55, dist ) ) * ( 1.0 - thread );
      vtpSgH += thread * 0.0007 * ( 0.6 + 0.4 * sin( seg * 6.2831 * 0.9 ) ) - groove * 0.0005;
      alb = mix( alb, uVtpSCS * ( 0.85 + 0.2 * dash ), thread );
      alb *= 1.0 - groove * 0.28;
      alb *= 1.0 - ( 1.0 - across ) * ( 1.0 - smoothstep( w, w * 1.6, dist ) ) * 0.12;   // puckered cloth beside the seam
    }
  }`;

const SHELL_FRAG = /* glsl */ `
  {
    float hN = vVtpSShH;
    // no fur over the drawn face (procedural mouth / eyes): the pile thins out toward each marker
    for ( int k = 0; k < 3; k ++ ) { vec4 fm = uVtpSFace[ k ]; if ( fm.w > 0.0 && hN > 0.15 + 0.85 * smoothstep( fm.w * 0.7, fm.w * 1.25, length( P - fm.xyz ) ) ) discard; }
    float spc = max( uVtpS3.y, 1e-4 );
    vec3 q = P / spc; vec3 c = floor( q ); vec3 r = vtpSf_h33( c );
    vec3 d = fract( q ) - 0.5 - ( r - 0.5 ) * 0.55;
    d -= N * dot( d, N );
    float strand = length( d );
    float lenK = 0.5 + 0.5 * r.y;
    float thick = 0.5 * pow( max( 1.0 - hN / lenK, 0.0 ), 0.8 ) * ( 0.75 + 0.5 * r.z );
    // strands thinner than a pixel alias into salt noise: widen them with distance (a soft pile silhouette instead)
    float cov = clamp( px / spc - 0.6, 0.0, 1.0 );
    thick = mix( thick, 0.75 * ( 1.0 - hN ), cov );
    if ( strand > thick || hN > lenK || r.x > mix( uVtpS4.y, 1.0, cov * 0.5 ) ) discard;
    alb *= mix( mix( 0.72, 1.05, hN ), 1.0, cov * 0.6 ) * mix( 0.94, 1.05, r.z );
  }`;

/** Belly region: the texture's own light belly patch (uVtpSBM = 1, measured on the CPU) or a soft front ellipse. */
const BELLY = /* glsl */ `
float vtpSf_belly( vec3 P, vec3 N ) {
  if ( uVtpSBM > 0.5 ) return smoothstep( 1.12, 1.45, vtpSf_lum( vtpSgAlb0 ) / max( uVtpSTintRef, 0.02 ) ) * smoothstep( -0.3, 0.2, N.z );
  float H = max( uVtpSH, 0.1 );
  float d = length( vec2( P.x / ( 0.12 * H ), ( P.y - 0.47 * H ) / ( 0.2 * H ) ) );
  return ( 1.0 - smoothstep( 0.7, 1.0, d ) ) * smoothstep( 0.2, 0.6, N.z );
}
`;

/** Called right after the host's albedo is final (map × colour × vertex colour). `dc` = diffuseColor. */
function surfaceFn(f: GlslFeatures): string {
  return BELLY + /* glsl */ `
void vtpSf_surface( inout vec4 dc ) {
  vec3 alb = dc.rgb;
  vtpSgAlb0 = alb;
  if ( uVtpSTint.a > 0.0 ) {
    float l = vtpSf_lum( alb ) / max( uVtpSTintRef, 0.03 );
    vec3 t = uVtpSTint.rgb * clamp( mix( 1.0, l, 0.7 ), 0.35, 1.6 );
    t /= 1.0 + max( vtpSf_lum( t ) - 0.72, 0.0 ) * 1.6;          // light tints: keep the detail, don't blow out
    alb = mix( alb, t, uVtpSTint.a );
  }
  vec3 P = vVtpSP;
  vec3 N = normalize( vVtpSN );
  float sz = max( uVtpS0.x, 1e-5 );
  float Q = uVtpSQ;
  float px = length( fwidth( vVtpSP ) );
  // stop-motion boil: the detail re-samples 12×/s
  if ( uVtpS1.w > 0.0 ) P += ( vtpSf_h33( vec3( floor( uVtpSTime * 12.0 ), 1.7, 3.3 ) ) - 0.5 ) * sz * 0.9 * uVtpS1.w;
  {
    ${kernelSurface(f)}
  }
  ${f.stitch ? STITCH : ''}
  ${f.shell ? SHELL_FRAG : ''}
  vtpSgH *= uVtpS0.y;
  dc.rgb = max( alb, 0.0 );
}
`;
}

/** Extra light on top of the host's shading (sheen, wax, iridescence, translucency, sparkle, glass rim, own cel spec). */
function lightFn(f: GlslFeatures): string {
  const fibre = f.kernel === 'fibre' || f.kernel === 'yarn';
  return /* glsl */ `
vec3 vtpSf_light( vec3 N, vec3 V, vec3 alb ) {
  vec3 L = normalize( vec3( 0.3, 0.6, 0.75 ) ); vec3 Lc = vec3( 0.0 ); float best = -1.0;
  #if NUM_DIR_LIGHTS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
    {
      float w = vtpSf_lum( directionalLights[ i ].color );
      if ( w > best ) { best = w; L = directionalLights[ i ].direction; Lc = directionalLights[ i ].color; }
    }
  }
  #pragma unroll_loop_end
  #endif
  Lc = min( Lc, vec3( 2.0 ) );
  float ndv = clamp( dot( N, V ), 0.0, 1.0 );
  float fres = 1.0 - ndv;
  float ndl = dot( N, L );
  float lit = smoothstep( -0.05, 0.3, ndl );
  vec3 Hv = normalize( L + V );
  float ndh = max( dot( N, Hv ), 0.0 );
  vec3 add = vec3( 0.0 );
  ${fibre ? /* glsl */ `
  {
    float fz = uVtpS0.w${f.kernel === 'fibre' && f.variant === 2 ? ' * mix( 0.55, 1.45, vtpSgNap )' : ''};
    add += uVtpSSheen * mix( alb, vec3( 1.0 ), 0.3 ) * fz * pow( fres, mix( 1.6, 4.0, uVtpS2.z ) ) * ( 0.3 + 0.7 * lit ) * Lc * 0.55;
  }` : ''}
  ${f.kernel === 'clay' ? 'add += Lc * pow( ndh, 14.0 ) * 0.1 * lit + alb * Lc * 0.05 * ( 1.0 - lit ) * smoothstep( -0.5, 0.0, ndl );' : ''}
  ${f.kernel === 'glass' ? 'add += Lc * pow( fres, 3.0 ) * 0.3 * vec3( 0.9, 0.95, 1.0 );' : ''}
  ${f.spec ? /* glsl */ `
  if ( uVtpS2.x > 0.02 ) {
    float s = pow( ndh, mix( 18.0, 160.0, uVtpS2.x ) ) - 0.45;
    float fw = fwidth( s ) + 1e-4;
    add += Lc * mix( alb, vec3( 1.0 ), 0.75 ) * smoothstep( -fw, fw, s ) * lit * uVtpS2.x * 0.55;
  }` : ''}
  if ( uVtpS1.y > 0.0 ) {
    float bs = pow( clamp( dot( V, -( L + N * 0.35 ) ), 0.0, 1.0 ), 3.0 );
    vec3 sat = max( mix( vec3( vtpSf_lum( alb ) ), alb, 1.5 ), 0.0 );
    add += sat * uVtpS1.y * ( bs * 0.7 + ( 1.0 - lit ) * 0.16 + fres * fres * 0.12 ) * Lc;
  }
  if ( uVtpS1.x > 0.0 ) {
    float ph = fres * 1.7 + vtpSgId * 0.4 + ndl * 0.25;
    vec3 film = 0.5 + 0.5 * cos( 6.2831 * ( ph + vec3( 0.0, 0.33, 0.67 ) ) );
    add += film * uVtpS1.x * ( 0.12 + 0.45 * fres * fres + 0.4 * pow( ndh, 8.0 ) * lit ) * vtpSf_lum( Lc ) * 0.5 * mix( 0.7, 1.0, vtpSgEdge );
  }
  if ( vtpSgSpark > 0.0 && uVtpSQ > 0.5 ) {
    vec3 c = floor( vVtpSP / 0.0016 );
    float h = vtpSf_h13( c + floor( dot( V, vec3( 3.1, 5.7, 7.3 ) ) * 5.0 ) );
    add += Lc * step( 0.993, h ) * lit * vtpSgSpark * uVtpS2.x * 0.9;
  }
  return min( add, vec3( 0.7 ) );
}
`;
}

export function fragPars(f: GlslFeatures): string {
  const needsTri = f.kernel === 'yarn' || f.kernel === 'stone' || (f.kernel === 'smooth' && f.variant === 3) || (f.kernel === 'scales' && f.variant !== 5);
  let pats = '';
  if (f.kernel === 'yarn') pats = f.variant === 4 ? PAT_CROCHET : PAT_KNIT(f.variant);
  else if (f.kernel === 'stone' || (f.kernel === 'smooth' && f.variant === 3)) pats = PAT_VORO;
  else if (f.kernel === 'scales') pats = PAT_SCUTE + (f.variant === 5 ? '' : PAT_SCALES(f.variant) + 'vec4 vtpSf_pat( vec2 q, float ax ) { return vtpSf_scale( q ); }\n');
  return FRAG_COMMON(f) + pats + (needsTri ? TRI : '') + surfaceFn(f) + lightFn(f);
}

export const FRAG_SURFACE_CALL = '  vtpSf_surface( diffuseColor );\n';
export const FRAG_BUMP_CALL = /* glsl */ `
  {
    // structural relief (scales, stitches, knit) bends the shading normal; fine noise (fibres, clay, grain) only
    // shades the albedo, so the crisp cel terminator and toon highlights don't break into dithered specks
    vec3 vtpSbN = vtpSf_bump( normal, vtpSgH );
    vec3 vtpSbL = vtpSf_key();
    diffuseColor.rgb *= clamp( 1.0 + ( dot( vtpSbN, vtpSbL ) - dot( normal, vtpSbL ) ) * 0.9 * ( 1.0 - uVtpSBN ), 0.55, 1.35 );
    normal = normalize( mix( normal, vtpSbN, uVtpSBN ) );
  }
`;
