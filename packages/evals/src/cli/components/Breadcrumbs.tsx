/** @jsxImportSource react */
import React from 'react';
import { Text } from 'ink';
import type { CliState } from '../types';

const SEP = '  ';
const ARROW = '›';

export function getBreadcrumbText(
  state: CliState,
  datasetName?: string,
  runLabel?: string,
): React.ReactNode {
  const dim = (s: string, k?: string) => (
    <Text key={k ?? s} color="gray">
      {s}
    </Text>
  );
  const accent = (s: string) => (
    <Text key={s} color="cyan" bold>
      {s}
    </Text>
  );

  if (state.level === 'datasets') {
    return (
      <>
        {dim('Evaluations')}
        {SEP}
        {dim(ARROW, 'a1')}
        {SEP}
        {accent('Datasets')}
      </>
    );
  }
  if (state.level === 'runs') {
    return (
      <>
        {dim('Evaluations')}
        {SEP}
        {dim(ARROW, 'a1')}
        {SEP}
        {dim('Dataset:')}{' '}
        <Text key="ds" color="white">
          {datasetName ?? '-'}
        </Text>
        {SEP}
        {dim(ARROW, 'a2')}
        {SEP}
        {accent('Runs')}
      </>
    );
  }
  if (state.level === 'details') {
    return (
      <>
        {dim('Evaluations')}
        {SEP}
        {dim(ARROW, 'a1')}
        {SEP}
        {dim('Dataset:')}{' '}
        <Text key="ds" color="white">
          {datasetName ?? '-'}
        </Text>
        {SEP}
        {dim(ARROW, 'a2')}
        {SEP}
        {dim('Run:')}{' '}
        <Text key="rl" color="white">
          {runLabel ?? '-'}
        </Text>
        {SEP}
        {dim(ARROW, 'a3')}
        {SEP}
        {accent('Details')}
      </>
    );
  }
  return (
    <>
      {dim('Evaluations')}
      {SEP}
      {dim(ARROW, 'a1')}
      {SEP}
      {accent('New evaluation')}
      {SEP}
      {dim(ARROW, 'a2')}
      {SEP}
      {dim('Select evaluators', 'sel')}
    </>
  );
}
