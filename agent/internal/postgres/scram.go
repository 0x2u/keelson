package postgres

import (
	"crypto/hmac"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
)

// scramIterations is the iteration count PostgreSQL itself uses for the verifiers it makes (scram_iterations).
const scramIterations = 4096

// scramVerifier is what PostgreSQL stores for a role's password under SCRAM-SHA-256 (RFC 5802 and 7677), in the
// form "SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>". It can be given to ALTER ROLE ... PASSWORD in
// place of the password, which PostgreSQL accepts as it is: the command then carries a verifier, not the password,
// so the password is in no command line, no container configuration and no server log.
func scramVerifier(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	return scramVerifierWith(password, salt, scramIterations)
}

func scramVerifierWith(password string, salt []byte, iterations int) (string, error) {
	// RFC 4013 SASLprep leaves printable ASCII as it is, which is all a generated password is. Anything else
	// would have to be normalised the way the server does it: refuse it rather than store a verifier no client matches.
	for _, r := range password {
		if r < 0x20 || r > 0x7e {
			return "", errors.New("the password holds a character other than printable ASCII")
		}
	}
	salted, err := pbkdf2.Key(sha256.New, password, salt, iterations, sha256.Size)
	if err != nil {
		return "", err
	}
	clientKey := hmacSHA256(salted, "Client Key")
	stored := sha256.Sum256(clientKey)
	server := hmacSHA256(salted, "Server Key")
	enc := base64.StdEncoding
	return fmt.Sprintf("SCRAM-SHA-256$%d:%s$%s:%s", iterations, enc.EncodeToString(salt), enc.EncodeToString(stored[:]), enc.EncodeToString(server)), nil
}

func hmacSHA256(key []byte, msg string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(msg))
	return m.Sum(nil)
}
