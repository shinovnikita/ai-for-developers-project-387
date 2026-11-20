import { MantineProvider } from '@mantine/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, assert, expect, test, vi } from 'vitest';
import App from './App';

afterEach(() => vi.unstubAllGlobals());

function renderPage(pathname: string) {
  vi.stubGlobal('location', new URL(pathname, 'http://localhost'));
  return renderToStaticMarkup(
    <MantineProvider env="test">
      <App />
    </MantineProvider>,
  );
}

test('главная объясняет гостю, как записаться на звонок', () => {
  const page = renderPage('/');

  expect(page).toMatch(/<h1\b[^>]*>Календарь звонков<\/h1>/);
  expect(page).toContain('Здесь можно записаться на звонок к владельцу календаря без регистрации');
});

test('главная ведёт в каталог типов встреч на странице записи', () => {
  const homepage = renderPage('/');
  const bookingLink = homepage.match(/<a\b[^>]* href="([^"]+)"[^>]*>(.*?)<\/a>/s);

  assert(bookingLink, 'На главной должна быть ссылка на страницу записи');
  const [, href, label] = bookingLink;
  expect(href).toBe('/booking');
  expect(label).toContain('Перейти к записи');

  const bookingPage = renderPage(href);

  expect(bookingPage).toMatch(/<h1\b[^>]*>Страница записи<\/h1>/);
  expect(bookingPage).toContain('Загружаем типы встреч');
});

test('страница владельца открывается по прямой ссылке и показывает форму создания типа встречи', () => {
  const ownerPage = renderPage('/owner');

  expect(ownerPage).toMatch(/<h1\b[^>]*>Календарь владельца<\/h1>/);
  expect(ownerPage).toContain('Название');
  expect(ownerPage).toContain('Описание');
  expect(ownerPage).toContain('Длительность в минутах');
  expect(ownerPage).toContain('Создать тип встречи');
});
