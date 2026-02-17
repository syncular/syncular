#!/usr/bin/env bun
import { fixEsmImportsInDirectory } from '../lib/esm-imports';

const distDir = process.argv[2] ?? 'dist';
fixEsmImportsInDirectory(distDir);
