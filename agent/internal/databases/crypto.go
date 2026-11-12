package databases

import (
	"errors"
	"fmt"
	"io"
	"os"

	"filippo.io/age"
)

// ErrWrongKey is returned when none of the keys given can decrypt a backup.
var ErrWrongKey = errors.New("this key cannot decrypt the backup")

// encryptFile writes src, encrypted to every recipient, to dst and returns the size of dst. The recipients are
// public keys: the agent can write backups it can never read.
func encryptFile(src, dst string, recipients []string) (int64, error) {
	rs := make([]age.Recipient, 0, len(recipients))
	for _, r := range recipients {
		x, err := age.ParseX25519Recipient(r)
		if err != nil {
			return 0, fmt.Errorf("recipient %q: %w", r, err)
		}
		rs = append(rs, x)
	}
	in, err := os.Open(src)
	if err != nil {
		return 0, err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, err
	}
	w, err := age.Encrypt(out, rs...)
	if err != nil {
		out.Close()
		return 0, err
	}
	if _, err := io.Copy(w, in); err != nil {
		out.Close()
		return 0, err
	}
	if err := w.Close(); err != nil {
		out.Close()
		return 0, err
	}
	if err := out.Close(); err != nil {
		return 0, err
	}
	info, err := os.Stat(dst)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

// decryptFile writes the plaintext of src to dst. A file that was cut or altered fails the copy: age authenticates
// every chunk.
func decryptFile(src, dst string, id age.Identity) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	r, err := age.Decrypt(in, id)
	if err != nil {
		var noMatch *age.NoIdentityMatchError
		if errors.As(err, &noMatch) {
			return ErrWrongKey
		}
		return fmt.Errorf("the backup is not a valid age file: %w", err)
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, r); err != nil {
		out.Close()
		return fmt.Errorf("decrypt the backup: %w", err)
	}
	return out.Close()
}
