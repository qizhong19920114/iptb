package main

import (
	"bytes"
	"compress/gzip"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"text/template"
)

var tpl = `
package main

import (
	"compress/gzip"
	"encoding/hex"
	"io"
	"bytes"
)

var _bundle = "{{.Data}}"

func Bundle() (io.Reader, error) {
	bs, err := hex.DecodeString(_bundle)
	if err != nil {
		return nil, err
	}

	br := bytes.NewReader(bs)

	zr, err := gzip.NewReader(br)
	if err != nil {
		return nil, err
	}

	return zr, nil
}
`

type asset struct {
	Data string
}

func main() {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	br, err := os.OpenFile("./dist/server.bundle.js", os.O_RDONLY, 0)
	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}

	_, err = io.Copy(zw, br)

	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}

	if err := zw.Close(); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}

	tmpl, err := template.New("bundle").Parse(tpl)
	if err != nil {
		fmt.Println(err)
		os.Exit(1)
	}

	ot, err := os.Create("./bundle.go")

	ast := asset{
		Data: hex.EncodeToString(buf.Bytes()),
	}

	if err := tmpl.Execute(ot, ast); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}
