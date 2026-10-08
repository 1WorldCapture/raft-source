// Credential primitives: raw key generation, argon2id hashing, indexed
// prefixes, the RFC v9.9 §X.2 key fingerprint, and the device-code HMAC
// lookup hash. Raw keys are returned exactly once to the caller and never
// persisted or logged in raw form.
package computer

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"math/big"

	"golang.org/x/crypto/argon2"

	"raft.local/server-go/internal/auth"
)

// Wire prefixes (TS parity). sk_daemon_ is accepted as a legacy machine key
// on the daemon transport; it is NOT a Computer-surface alias.
const (
	ComputerKeyPrefix = "sk_computer_"
	MachineKeyPrefix  = "sk_machine_"
	DaemonKeyPrefix   = "sk_daemon_"

	deviceCodePrefix = "dvc_"

	// TS COMPUTER_API_KEY_PREFIX_LENGTH / API_KEY_PREFIX_LENGTH.
	computerKeyPrefixLen = 16
	machineKeyPrefixLen  = 20

	// TS COMPUTER_RAW_KEY_BYTES / machine registerMachine raw entropy.
	computerRawKeyBytes = 32
	machineRawKeyBytes  = 32

	deviceCodeBytes    = 32
	deviceUsercodeLen  = 8
	fingerprintHexLen  = 16
	minPepperKeyLength = 32
)

// Argon2Config carries the argon2id parameters for API-key/device-code
// hashes. The zero value uses production defaults matching the TS argon2
// defaults; tests inject cheap parameters.
type Argon2Config struct {
	MemoryKiB   uint32
	Iterations  uint32
	Parallelism uint8
}

// DefaultArgon2 mirrors the argon2 defaults used by the TS server
// (argon2.hash with no overrides).
func DefaultArgon2() Argon2Config {
	return Argon2Config{MemoryKiB: 19456, Iterations: 2, Parallelism: 1}
}

func (c Argon2Config) withDefaults() Argon2Config {
	if c.MemoryKiB == 0 || c.Iterations == 0 || c.Parallelism == 0 {
		d := DefaultArgon2()
		if c.MemoryKiB == 0 {
			c.MemoryKiB = d.MemoryKiB
		}
		if c.Iterations == 0 {
			c.Iterations = d.Iterations
		}
		if c.Parallelism == 0 {
			c.Parallelism = d.Parallelism
		}
	}
	return c
}

// One process-wide gate bounds BOTH mint and verify derivations. Creating a
// fresh per-request hasher/semaphore would not provide a memory bound.
var secretDerivations = make(chan struct{}, 4)
var strictSecretVerifier = auth.NewPasswordHasher(19456, 2, 1, 4)

func validateArgonConfig(cfg Argon2Config) error {
	if cfg.MemoryKiB < 8 || cfg.MemoryKiB > 256*1024 || cfg.Iterations < 1 || cfg.Iterations > 10 || cfg.Parallelism < 1 || cfg.Parallelism > 8 {
		return fmt.Errorf("computer: Argon2 parameters are outside supported bounds")
	}
	return nil
}

// hashSecret derives a bounded, canonical argon2id verifier for a raw secret.
func hashSecret(cfg Argon2Config, secret string) (string, error) {
	cfg = cfg.withDefaults()
	if err := validateArgonConfig(cfg); err != nil {
		return "", err
	}
	secretDerivations <- struct{}{}
	defer func() { <-secretDerivations }()
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("computer: salt: %w", err)
	}
	dk := argon2.IDKey([]byte(secret), salt, cfg.Iterations, cfg.MemoryKiB, cfg.Parallelism, 32)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		cfg.MemoryKiB, cfg.Iterations, cfg.Parallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(dk)), nil
}

// verifySecret checks a raw secret against an encoded argon2id hash with
// the parameters embedded in the hash. Malformed hashes verify false.
func verifySecret(encoded, secret string) bool {
	if len(encoded) > 1024 || len(secret) > 4096 {
		return false
	}
	secretDerivations <- struct{}{}
	defer func() { <-secretDerivations }()
	// M1's verifier rejects empty/oversized salt and digest, noncanonical or
	// duplicate parameters, integer overflow and unreasonable Argon costs
	// before deriving. Invalid stored data must never reach IDKey(keyLen=0).
	return strictSecretVerifier.Verify(secret, encoded)
}

// GenerateComputerKeyMaterial mints a fresh sk_computer_* key with its
// argon2id hash and indexed prefix (first 16 chars of the raw key).
func GenerateComputerKeyMaterial(cfg Argon2Config) (apiKey, apiKeyHash, apiKeyPrefix string, err error) {
	raw, err := randomHex(computerRawKeyBytes)
	if err != nil {
		return "", "", "", err
	}
	apiKey = ComputerKeyPrefix + raw
	apiKeyHash, err = hashSecret(cfg, apiKey)
	if err != nil {
		return "", "", "", err
	}
	return apiKey, apiKeyHash, apiKey[:computerKeyPrefixLen], nil
}

// GenerateMachineKeyMaterial mints a fresh sk_machine_* key with hash,
// prefix (first 20 chars) and the sha256 fingerprint shared with the on-disk
// daemon owner.json.
func GenerateMachineKeyMaterial(cfg Argon2Config) (apiKey, apiKeyHash, apiKeyPrefix, apiKeyFingerprint string, err error) {
	raw, err := randomHex(machineRawKeyBytes)
	if err != nil {
		return "", "", "", "", err
	}
	apiKey = MachineKeyPrefix + raw
	apiKeyHash, err = hashSecret(cfg, apiKey)
	if err != nil {
		return "", "", "", "", err
	}
	return apiKey, apiKeyHash, apiKey[:machineKeyPrefixLen], MachineAPIKeyFingerprint(apiKey), nil
}

// MachineAPIKeyFingerprint is sha256(apiKey) hex truncated to 16 chars.
func MachineAPIKeyFingerprint(apiKey string) string {
	sum := sha256.Sum256([]byte(apiKey))
	return hex.EncodeToString(sum[:])[:fingerprintHexLen]
}

// IsComputerAPIKey reports the sk_computer_* wire shape.
func IsComputerAPIKey(token string) bool {
	return len(token) > len(ComputerKeyPrefix) && token[:len(ComputerKeyPrefix)] == ComputerKeyPrefix
}

// IsMachineAPIKey reports the legacy sk_machine_* / sk_daemon_* shapes.
func IsMachineAPIKey(token string) bool {
	return hasWirePrefix(token, MachineKeyPrefix) || hasWirePrefix(token, DaemonKeyPrefix)
}

func hasWirePrefix(token, prefix string) bool {
	return len(token) > len(prefix) && token[:len(prefix)] == prefix
}

// DeviceCodeLookupHash is the deterministic HMAC-SHA256(pepper, code) used to
// locate a device grant at poll time. Byte-identical in construction to the
// TS computeTokenLookupHash (raw digest bytes).
func DeviceCodeLookupHash(pepper []byte, code string) []byte {
	mac := hmac.New(sha256.New, pepper)
	mac.Write([]byte(code))
	return mac.Sum(nil)
}

func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("computer: entropy: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

// crockfordAlphabet excludes I/L/O/U so humans cannot misread a user code.
const crockfordAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// newUserCode rolls the human-typed XXXX-XXXX code (TS humanUserCode).
func newUserCode() (string, error) {
	out := make([]byte, deviceUsercodeLen)
	for i := range out {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(crockfordAlphabet))))
		if err != nil {
			return "", fmt.Errorf("computer: user code: %w", err)
		}
		out[i] = crockfordAlphabet[n.Int64()]
	}
	return string(out[:4]) + "-" + string(out[4:]), nil
}

// newDeviceCode rolls the raw dvc_<base64url> secret (TS createDeviceAuthorization).
func newDeviceCode() (string, error) {
	buf := make([]byte, deviceCodeBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("computer: device code: %w", err)
	}
	return deviceCodePrefix + base64.RawURLEncoding.EncodeToString(buf), nil
}

// NewID mints a random RFC 4122 version-4 UUID string (same shape as every
// other id column).
func NewID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		panic(fmt.Sprintf("computer: crypto/rand failed: %v", err))
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", buf[0:4], buf[4:6], buf[6:8], buf[8:10], buf[10:16])
}
