// Package runtimecatalog is the M3 runtime-catalog slice for original Web
// Agent creation: admission projections, versioned create-form definitions,
// and the machine metadata RPC that asks a connected Computer which models
// a runtime can actually launch.
//
// Persisted machines.runtimes is the only installed-runtime source. Feature
// flags that are not stored (C0) evaluate disabled. A missing Computer
// connection never becomes a successful model list or a successful rescan.
package runtimecatalog
